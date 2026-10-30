/**
 * SFTP adapter over `ssh2` — the only file in the package that speaks SSH.
 *
 * `ssh2` is imported lazily so the plugin still loads (and every tool still
 * reports a useful error) when the library is missing or its optional native
 * build was skipped. The adapter exposes exactly the six methods
 * `RemoteFs` needs; nothing above this file knows what SFTP is.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolveLocal } from 'node:path';
import { RemoteFsError } from './remote-fs.mjs';

const FILE_TYPE_MASK = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function typeOf(mode) {
  const kind = (mode ?? 0) & FILE_TYPE_MASK;
  if (kind === S_IFDIR) return 'dir';
  if (kind === S_IFLNK) return 'link';
  return 'file';
}

function call(target, method, ...args) {
  return new Promise((resolveCall, rejectCall) => {
    target[method](...args, (error, value) => (error ? rejectCall(error) : resolveCall(value)));
  });
}

function mapError(error, path) {
  const code = error?.code;
  if (code === 2) return new RemoteFsError('REMOTE_NOT_FOUND', `remote path not found: ${path}`, error);
  if (code === 3) return new RemoteFsError('REMOTE_PERMISSION_DENIED', `permission denied on remote: ${path}`, error);
  return new RemoteFsError('REMOTE_IO_ERROR', `SFTP ${path}: ${error?.message ?? String(error)}`, error);
}

function localKeyPath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolveLocal(homedir(), value.slice(2));
  return resolveLocal(value);
}

function fingerprintOf(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Open one SSH connection and wrap its SFTP channel in the adapter contract.
 * Resolves to `{ adapter, home }`; `home` is the remote login home, used to
 * expand `~` in `remoteRoot`.
 */
export async function createSsh2Adapter(connection, config) {
  let ssh2;
  try {
    ssh2 = await import('ssh2');
  } catch (error) {
    throw new RemoteFsError(
      'SSH2_MISSING',
      'the ssh2 package is not installed; reinstall the plugin with its dependencies (ssh2 ^1.17)',
      error,
    );
  }

  const connectConfig = {
    host: connection.host,
    port: connection.port,
    readyTimeout: config.connectTimeoutMs,
    keepaliveInterval: config.keepaliveIntervalMs,
    keepaliveCountMax: 3,
  };
  if (connection.username) connectConfig.username = connection.username;

  // Host-key trust. When a fingerprint is configured the key must match it;
  // without one ssh2 accepts any key, which is documented as the default trust
  // model in the README — pin it for anything beyond a trusted LAN.
  if (connection.hostFingerprint) {
    const expected = connection.hostFingerprint.trim();
    connectConfig.hostVerifier = (key) => fingerprintOf(key) === expected || fingerprintOf(key) === `SHA256:${expected}`;
  }

  const auth = connection.auth ?? { kind: 'agent' };
  if (auth.kind === 'key') {
    connectConfig.privateKey = await readFile(localKeyPath(auth.privateKeyPath), 'utf8');
    if (auth.passphrase) connectConfig.passphrase = auth.passphrase;
  } else if (auth.kind === 'password') {
    connectConfig.password = auth.password;
  } else {
    const agent = auth.agent || process.env.SSH_AUTH_SOCK;
    if (!agent) {
      throw new RemoteFsError(
        'SSH_AGENT_MISSING',
        `connection ${connection.id} uses agent auth but no agent socket is configured (auth.agent or SSH_AUTH_SOCK)`,
      );
    }
    connectConfig.agent = agent;
  }

  const client = new ssh2.Client();
  await new Promise((resolveReady, rejectReady) => {
    const onError = (error) => {
      client.removeListener('ready', onReady);
      rejectReady(new RemoteFsError('SSH_CONNECT_FAILED', `${connection.host}:${connection.port} — ${error?.message ?? error}`, error));
    };
    const onReady = () => {
      client.removeListener('error', onError);
      resolveReady();
    };
    client.once('error', onError);
    client.once('ready', onReady);
    client.connect(connectConfig);
  });

  let sftp;
  try {
    sftp = await call(client, 'sftp');
  } catch (error) {
    client.end();
    throw new RemoteFsError('SSH_SFTP_UNAVAILABLE', 'the target accepted SSH but refused the SFTP subsystem', error);
  }

  let home;
  try {
    home = await call(sftp, 'realpath', '.');
  } catch {
    home = '/';
  }

  const adapter = {
    async list(path) {
      let items;
      try {
        items = await call(sftp, 'readdir', path);
      } catch (error) {
        throw mapError(error, path);
      }
      return items.map((item) => ({
        name: item.filename,
        type: typeOf(item.attrs?.mode),
        size: item.attrs?.size ?? 0,
        mtimeMs: (item.attrs?.mtime ?? 0) * 1000,
      }));
    },

    async stat(path) {
      try {
        const attrs = await call(sftp, 'stat', path);
        return { type: typeOf(attrs.mode), size: attrs.size ?? 0, mtimeMs: (attrs.mtime ?? 0) * 1000 };
      } catch (error) {
        throw mapError(error, path);
      }
    },

    async readText(path, maxBytes) {
      let handle;
      try {
        handle = await call(sftp, 'open', path, 'r');
      } catch (error) {
        throw mapError(error, path);
      }
      try {
        const attrs = await call(sftp, 'fstat', handle);
        const size = attrs?.size ?? 0;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          // eslint-disable-next-line no-await-in-loop
          const read = await call(sftp, 'read', handle, buffer, offset, length - offset, offset);
          if (!read) break;
          offset += read;
        }
        return {
          text: buffer.subarray(0, offset).toString('utf8'),
          bytes: offset,
          truncated: offset < size,
        };
      } finally {
        await call(sftp, 'close', handle).catch(() => {});
      }
    },

    async writeText(path, text) {
      const body = Buffer.from(text, 'utf8');
      const temp = `${path}.dshrc-tmp-${process.pid}-${Date.now()}`;
      try {
        await call(sftp, 'writeFile', temp, body);
        await call(sftp, 'rename', temp, path);
      } catch (error) {
        await call(sftp, 'unlink', temp).catch(() => {});
        throw mapError(error, path);
      }
      return { bytes: body.length };
    },

    async mkdirp(dir) {
      const parts = dir.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += `/${part}`;
        try {
          // eslint-disable-next-line no-await-in-loop
          await call(sftp, 'mkdir', current);
        } catch (error) {
          if (error?.code === 4) continue; // already exists (OpenSSH reports EEXIST as generic failure)
          // eslint-disable-next-line no-await-in-loop
          const attrs = await call(sftp, 'stat', current).catch(() => undefined);
          if (!attrs || typeOf(attrs.mode) !== 'dir') throw mapError(error, current);
        }
      }
    },

    async rename(from, to) {
      try {
        await call(sftp, 'rename', from, to);
      } catch (error) {
        throw mapError(error, from);
      }
    },

    async close() {
      try {
        sftp.end?.();
      } catch {
        /* already gone */
      }
      client.end();
    },
  };

  return { adapter, home };
}
