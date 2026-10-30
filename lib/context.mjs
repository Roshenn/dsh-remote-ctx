/**
 * The service layer shared by the tools and the panel.
 *
 * Holds the connection records, one lazily opened `RemoteFs` per connection
 * (closed after `idleTtlMs`), and the cached index. Tools get their own view of
 * this through `apply()`; the HTTP API gets the same object, so the browser and
 * the model always describe the same connections.
 */
import { homedir } from 'node:os';
import { ConnectionError, findConnection, normalizeConnection, readStore, removeConnection, toPublicConnection, upsertConnection, writeStore } from './config.mjs';
import { buildIndex, dropIndex, loadIndex, saveIndex } from './indexer.mjs';
import { slugify } from './paths.mjs';
import { openRemote } from './remote-fs.mjs';
import { readDiscoveredHosts } from './ssh-config.mjs';
import { createAnchor } from './workspace.mjs';

export class RemoteContext {
  constructor(config, options = {}) {
    this.config = config;
    this.openRemote = options.openRemote ?? openRemote;
    this.adapterFor = options.adapterFor; // (connection) => adapter | undefined; test seam
    this.registry = options.registry; // () => ctx.workspaceRegistry | undefined; optional host service
    this.pool = new Map();
    this.store = readStore(config);
  }

  reload() {
    this.store = readStore(this.config);
    return this.store;
  }

  listConnections() {
    return this.store.connections.map(toPublicConnection);
  }

  getConnection(id) {
    const connection = findConnection(this.store, id);
    if (!connection) throw new ConnectionError('CONNECTION_NOT_FOUND', `no connection with id ${JSON.stringify(id)}`);
    return connection;
  }

  /** Create or update a connection from an untrusted record. */
  saveConnection(raw) {
    const previous = raw?.id ? findConnection(this.store, raw.id) : undefined;
    const connection = normalizeConnection(raw, { previous });
    const duplicate = this.store.connections.find((entry) => entry.id === connection.id && entry !== previous);
    if (duplicate) throw new ConnectionError('CONNECTION_EXISTS', `connection id ${connection.id} already exists`);
    this.store = upsertConnection(this.store, connection);
    writeStore(this.config, this.store);
    return toPublicConnection(connection);
  }

  deleteConnection(id) {
    this.getConnection(id);
    this.store = removeConnection(this.store, id);
    writeStore(this.config, this.store);
    void this.close(id);
    dropIndex(this.config.indexDir, id);
    return true;
  }

  /** The pooled `RemoteFs`, opening or re-opening it when needed. */
  async remote(id) {
    const entry = this.pool.get(id);
    if (entry && Date.now() - entry.lastUsed <= this.config.idleTtlMs) return entry.fs;
    if (entry) await this.close(id);
    const connection = this.getConnection(id);
    const adapter = this.adapterFor?.(connection);
    const fs = await this.openRemote(connection, this.config, { adapter });
    this.pool.set(id, { fs });
    return fs;
  }

  async close(id) {
    const entry = this.pool.get(id);
    if (!entry) return;
    this.pool.delete(id);
    await entry.fs.close();
  }

  async closeIdle() {
    const now = Date.now();
    const stale = [...this.pool.entries()]
      .filter(([, entry]) => now - entry.fs.lastUsed > this.config.idleTtlMs)
      .map(([id]) => id);
    await Promise.all(stale.map((id) => this.close(id)));
    return stale;
  }

  async closeAll() {
    const ids = [...this.pool.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  poolState() {
    const now = Date.now();
    const state = {};
    for (const [id, entry] of this.pool.entries()) {
      state[id] = { connected: true, root: entry.fs.root, idleMs: now - entry.fs.lastUsed };
    }
    return state;
  }

  /**
   * Hosts already described by the user's `~/.ssh/config`, each flagged with
   * whether this plugin already has a connection for it.
   */
  discoverSshHosts() {
    const discovered = readDiscoveredHosts(this.config.sshConfigFile, { home: homedir() });
    const ids = new Set(this.store.connections.map((connection) => connection.id));
    return {
      ...discovered,
      entries: discovered.entries.map((entry) => ({ ...entry, id: slugify(entry.alias), added: ids.has(slugify(entry.alias)) })),
    };
  }

  /**
   * Create a connection from one discovered Host alias.
   *
   * A Host that needs ProxyJump/ProxyCommand is refused: the adapter speaks a
   * direct SFTP session only, and a connection record that silently ignores the
   * jump host would fail later with a much worse error.
   */
  importSshHost(alias) {
    const discovered = this.discoverSshHosts();
    const entry = discovered.entries.find((candidate) => candidate.alias === alias);
    if (!entry) throw new ConnectionError('SSH_HOST_NOT_FOUND', `no Host ${JSON.stringify(alias)} in ${discovered.path}`);
    if (entry.proxyJump || entry.proxyCommand) {
      throw new ConnectionError(
        'SSH_PROXY_UNSUPPORTED',
        `Host ${alias} uses ${entry.proxyJump ? 'ProxyJump' : 'ProxyCommand'}; this plugin opens direct SFTP sessions only`,
      );
    }
    if (this.store.connections.some((connection) => connection.id === entry.id)) {
      throw new ConnectionError('CONNECTION_EXISTS', `connection ${entry.id} already exists`);
    }
    return this.saveConnection({
      id: entry.id,
      label: entry.alias,
      host: entry.hostName,
      port: entry.port,
      username: entry.user,
      remoteRoot: '~',
      ...(entry.identityFile ? { privateKeyPath: entry.identityFile } : {}),
    });
  }

  /** The workspace registry when the host exposes it; never throws. */
  resolveRegistry() {
    if (!this.registry) return undefined;
    try {
      return typeof this.registry === 'function' ? this.registry() : this.registry;
    } catch {
      return undefined;
    }
  }

  /**
   * Register a remote directory as a DSH workspace through a local anchor.
   *
   * The registry requires a local directory, so the anchor is what gets owned;
   * its AGENTS.md points the agent at the remote tools. Same connection + path
   * returns the same anchor and the registry's create() is idempotent per path,
   * so pressing the button twice cannot duplicate a workspace.
   */
  async createWorkspace(id, relativePath, title) {
    const fs = this.remote ? await this.remote(id) : undefined;
    const connection = this.getConnection(id);
    const remotePath = fs.resolve(relativePath);
    const anchor = createAnchor({
      workspacesDir: this.config.workspacesDir,
      connection,
      remotePath,
    });
    const registry = this.resolveRegistry();
    let registered = false;
    let workspace;
    if (registry && typeof registry.create === 'function') {
      const name = title || `${connection.label ?? connection.id} · ${fs.relative(remotePath)}`;
      workspace = await registry.create(anchor.path, name);
      registered = true;
    }
    return {
      ...anchor,
      registered,
      workspace: workspace
        ? { id: String(workspace.id), path: workspace.path, title: workspace.title }
        : undefined,
    };
  }

  /** Cached index, or a fresh walk when `refresh` is set. */
  async indexFor(id, options = {}) {
    if (!options.refresh) {
      const cached = loadIndex(this.config.indexDir, id);
      if (cached) return cached;
    }
    const fs = await this.remote(id);
    const index = await buildIndex(fs, {
      maxDepth: options.maxDepth ?? this.config.maxIndexDepth,
      maxFiles: options.maxFiles ?? this.config.maxIndexFiles,
    });
    saveIndex(this.config.indexDir, index);
    return index;
  }

  readIndex(id) {
    return loadIndex(this.config.indexDir, id);
  }
}
