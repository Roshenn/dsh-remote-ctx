/**
 * The remote filesystem facade.
 *
 * One object per pooled SSH connection. Everything the tools and the panel do
 * arrives here as an absolute POSIX path, is re-confined to the connection's
 * `remoteRoot`, and is then handed to a small adapter:
 *
 *   list(dir)                 -> [{ name, type, size, mtimeMs }]
 *   stat(path)                -> { type, size, mtimeMs }
 *   readText(path, maxBytes)  -> { text, bytes, truncated }
 *   writeText(path, text)     -> { bytes }
 *   mkdirp(dir)               -> void
 *   rename(from, to)          -> void
 *   close()                   -> void
 *
 * `lib/ssh2-adapter.mjs` implements it over SFTP. Tests implement the same six
 * methods in memory, which is why the walker, the index and the tools can be
 * exercised without a network or a live host.
 */
import { posix } from 'node:path';
import { compareText, resolveWithinRoot, relativeToRoot, joinRemote, normalizeRemotePath, expandHome } from './paths.mjs';

export const DEFAULT_IGNORE = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.dsh', '.DS_Store', 'vendor',
]);

export class RemoteFsError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'RemoteFsError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class RemoteFs {
  /**
   * @param {object} options
   * @param {object} options.connection normalised connection record
   * @param {object} options.adapter    low-level remote adapter
   * @param {string} options.home      remote login home, used to expand `~`
   * @param {object} options.config    resolved plugin config
   */
  constructor(options) {
    this.connection = options.connection;
    this.adapter = options.adapter;
    // The host key the target actually presented, when the adapter saw one.
    // Read-only material for the panel; never used to decide anything here.
    this.hostFingerprint = options.adapter?.hostFingerprint;
    this.home = options.home ?? '/';
    this.config = options.config;
    this.root = normalizeRemotePath(expandHome(options.connection.remoteRoot, this.home), { home: this.home });
    this.lastUsed = Date.now();
    this.lastError = null;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  /** Confine a requested path (absolute or root-relative) to this connection's root. */
  resolve(requested) {
    const raw = requested === undefined || requested === null || String(requested).trim() === ''
      ? undefined
      : String(requested).trim();
    const expanded = raw === undefined ? undefined : expandHome(raw, this.home);
    return resolveWithinRoot(this.root, expanded, { home: this.home });
  }

  relative(requested) {
    return relativeToRoot(this.root, this.resolve(requested));
  }

  absolute(relative) {
    return joinRemote(this.root, relative);
  }

  async list(requested) {
    const path = this.resolve(requested);
    const entries = await this.adapter.list(path);
    this.touch();
    return {
      path,
      relative: relativeToRoot(this.root, path),
      entries: entries
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .map((entry) => ({ ...entry, path: posix.join(path, entry.name) }))
        .sort((left, right) => (left.type === right.type ? compareText(left.name, right.name) : left.type === 'dir' ? -1 : 1)),
    };
  }

  async stat(requested) {
    const path = this.resolve(requested);
    const stat = await this.adapter.stat(path);
    this.touch();
    return { path, ...stat };
  }

  async readText(requested, options = {}) {
    const path = this.resolve(requested);
    const maxBytes = Math.max(1, Math.min(Number(options.maxBytes) || this.config?.maxReadBytes || 262144, 8 * 1024 * 1024));
    const result = await this.adapter.readText(path, maxBytes);
    this.touch();
    return { path, ...result };
  }

  async writeText(requested, text) {
    if (this.config?.allowRemoteWrite === false) {
      throw new RemoteFsError('REMOTE_WRITE_DISABLED', 'remote writes are disabled by plugin config (allowRemoteWrite: false)');
    }
    const path = this.resolve(requested);
    const parent = posix.dirname(path);
    if (parent !== path) await this.adapter.mkdirp(parent);
    const result = await this.adapter.writeText(path, text);
    this.touch();
    return { path, ...result };
  }

  /**
   * Walk the tree below `requested`, breadth first, bounded in both depth and
   * file count. A directory that cannot be listed is reported in `errors` and
   * does not abort the walk — a stale index is better than no index.
   */
  async walk(requested, options = {}) {
    const start = this.resolve(requested);
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : (this.config?.maxIndexDepth ?? 8);
    const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : (this.config?.maxIndexFiles ?? 20000);
    const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
    const entries = [];
    const errors = [];
    const queue = [{ path: start, depth: 0 }];
    let truncated = false;
    let dirsScanned = 0;

    while (queue.length > 0) {
      const { path, depth } = queue.shift();
      if (depth > maxDepth) {
        truncated = true;
        continue;
      }
      let listing;
      try {
        // eslint-disable-next-line no-await-in-loop
        listing = await this.adapter.list(path);
      } catch (error) {
        errors.push({ path, message: error?.message ?? String(error) });
        continue;
      }
      dirsScanned += 1;
      const direct = listing
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .filter((entry) => !ignore.has(entry.name))
        .sort((left, right) => compareText(left.name, right.name));
      for (const entry of direct) {
        if (entries.length >= maxFiles) {
          truncated = true;
          queue.length = 0;
          break;
        }
        const absolute = posix.join(path, entry.name);
        entries.push({
          path: relativeToRoot(this.root, absolute),
          type: entry.type,
          size: entry.size ?? 0,
          mtimeMs: entry.mtimeMs ?? 0,
        });
        if (entry.type === 'dir') queue.push({ path: absolute, depth: depth + 1 });
      }
    }

    entries.sort((left, right) => compareText(left.path, right.path));
    return { root: this.root, entries, truncated, dirsScanned, errors, maxDepth, maxFiles };
  }

  async close() {
    try {
      await this.adapter.close?.();
    } catch {
      /* closing a broken connection is best effort */
    }
  }
}

/**
 * Open a `RemoteFs` for one connection.
 *
 * `options.adapter` is the test seam: pass an in-memory implementation of the
 * six adapter methods and no SSH client is constructed at all.
 */
export async function openRemote(connection, config, options = {}) {
  if (options.adapter) {
    return new RemoteFs({ connection, adapter: options.adapter, home: options.home ?? '/', config });
  }
  const { createSsh2Adapter } = await import('./ssh2-adapter.mjs');
  const { adapter, home } = await createSsh2Adapter(connection, config);
  return new RemoteFs({ connection, adapter, home, config });
}
