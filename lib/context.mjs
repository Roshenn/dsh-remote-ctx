/**
 * The service layer shared by the tools and the panel.
 *
 * Holds the connection records, one lazily opened `RemoteFs` per connection
 * (closed after `idleTtlMs`), and the cached index. Tools get their own view of
 * this through `apply()`; the HTTP API gets the same object, so the browser and
 * the model always describe the same connections.
 */
import { ConnectionError, findConnection, normalizeConnection, readStore, removeConnection, toPublicConnection, upsertConnection, writeStore } from './config.mjs';
import { buildIndex, dropIndex, loadIndex, saveIndex } from './indexer.mjs';
import { openRemote } from './remote-fs.mjs';

export class RemoteContext {
  constructor(config, options = {}) {
    this.config = config;
    this.openRemote = options.openRemote ?? openRemote;
    this.adapterFor = options.adapterFor; // (connection) => adapter | undefined; test seam
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
