/**
 * In-memory stand-in for `lib/ssh2-adapter.mjs`.
 *
 * It implements the same six adapter methods over a Map, so every layer above
 * SFTP — path confinement, the walker, the index, the mirror, the tools, the
 * HTTP API — is exercised with real code paths and no network.
 */
import { posix } from 'node:path';

function fsError(code, path) {
  const error = new Error(`${code === 2 ? 'no such file' : 'failure'}: ${path}`);
  error.code = code;
  return error;
}

export function createFakeRemote(options = {}) {
  const home = options.home ?? '/home/tester';
  const dirs = new Set(['/', home, '/etc']);
  const files = new Map();

  const adapter = {
    async list(path) {
      if (!dirs.has(path)) throw fsError(2, path);
      const direct = new Map();
      const prefix = path === '/' ? '/' : `${path}/`;
      for (const dir of dirs) {
        if (dir === path || !dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest && !rest.includes('/')) direct.set(rest, { name: rest, type: 'dir', size: 0, mtimeMs: 0 });
      }
      for (const [file, meta] of files) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest || rest.includes('/')) continue;
        direct.set(rest, { name: rest, type: 'file', size: Buffer.byteLength(meta.content), mtimeMs: meta.mtimeMs });
      }
      return [...direct.values()];
    },

    async stat(path) {
      if (dirs.has(path)) return { type: 'dir', size: 0, mtimeMs: 0 };
      const file = files.get(path);
      if (!file) throw fsError(2, path);
      return { type: 'file', size: Buffer.byteLength(file.content), mtimeMs: file.mtimeMs };
    },

    async readText(path, maxBytes) {
      const file = files.get(path);
      if (!file) throw fsError(2, path);
      const buffer = Buffer.from(file.content, 'utf8');
      const slice = buffer.subarray(0, Math.min(buffer.length, maxBytes));
      return { text: slice.toString('utf8'), bytes: slice.length, truncated: slice.length < buffer.length };
    },

    async writeText(path, text) {
      files.set(path, { content: text, mtimeMs: Date.now() });
      return { bytes: Buffer.byteLength(text) };
    },

    async mkdirp(path) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += `/${part}`;
        dirs.add(current);
      }
    },

    async rename(from, to) {
      const file = files.get(from);
      if (!file) throw fsError(2, from);
      files.delete(from);
      files.set(to, file);
    },

    async close() {
      /* nothing to close */
    },
  };

  return {
    home,
    adapter,
    dirs,
    files,
    /** Create a directory (and parents) on the fake target. */
    mkdir(path) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += `/${part}`;
        dirs.add(current);
      }
    },
    /** Seed a file; directories are created as needed. */
    seed(path, content) {
      this.mkdir(posix.dirname(path));
      files.set(path, { content, mtimeMs: Date.now() });
    },
    read(path) {
      return files.get(path)?.content;
    },
    /** The slice of the adapter contract a connection pool needs. */
    adapterFor() {
      return adapter;
    },
  };
}
