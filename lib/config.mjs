/**
 * Connection records.
 *
 * One JSON file under `$DSH_HOME/remote-ctx/` holds every connection; it is
 * written 0600 because a password-auth entry carries a secret. Everything the
 * model or the browser sends is normalised here before it can reach an SSH
 * client, and `toPublicConnection` is the only view that leaves the host half —
 * it never contains a password.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { normalizeRemotePath, slugify } from './paths.mjs';

export const DEFAULTS = Object.freeze({
  connectionsFile: '',
  indexDir: '',
  sshConfigFile: '',
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 15000,
  idleTtlMs: 180000,
  maxIndexFiles: 20000,
  maxIndexDepth: 8,
  maxReadBytes: 262144,
  allowRemoteWrite: true,
});

export const AUTH_KINDS = Object.freeze(['key', 'password', 'agent']);

export function dshHome(env = process.env) {
  return env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh');
}

/** Normalise the cordis row config; unknown keys are dropped, bad numbers fall back. */
export function resolveConfig(raw, env = process.env) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const home = dshHome(env);
  const number = (input, fallback, min) => (Number.isFinite(input) && input >= min ? Math.floor(input) : fallback);
  return {
    connectionsFile: typeof value.connectionsFile === 'string' && value.connectionsFile.trim()
      ? resolve(value.connectionsFile.trim())
      : join(home, 'remote-ctx', 'connections.json'),
    indexDir: typeof value.indexDir === 'string' && value.indexDir.trim()
      ? resolve(value.indexDir.trim())
      : join(home, 'remote-ctx', 'index'),
    // The SSH config belongs to the operating-system user, not to DSH's home,
    // so it does not default under $DSH_HOME.
    sshConfigFile: typeof value.sshConfigFile === 'string' && value.sshConfigFile.trim()
      ? resolve(value.sshConfigFile.trim())
      : join(homedir(), '.ssh', 'config'),
    connectTimeoutMs: number(value.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 1000),
    keepaliveIntervalMs: number(value.keepaliveIntervalMs, DEFAULTS.keepaliveIntervalMs, 0),
    idleTtlMs: number(value.idleTtlMs, DEFAULTS.idleTtlMs, 0),
    maxIndexFiles: number(value.maxIndexFiles, DEFAULTS.maxIndexFiles, 1),
    maxIndexDepth: number(value.maxIndexDepth, DEFAULTS.maxIndexDepth, 0),
    maxReadBytes: number(value.maxReadBytes, DEFAULTS.maxReadBytes, 1),
    allowRemoteWrite: value.allowRemoteWrite !== false,
  };
}

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Accept both the flat shape (host/port/username/privateKeyPath, the one
 * `$DSH_HOME/dsh-ssh-connections.json` already uses) and an explicit
 * `auth: { kind }` object.
 */
function normalizeAuth(raw, previous) {
  const source = raw.auth && typeof raw.auth === 'object' ? raw.auth : {};
  const legacyKey = optionalString(raw.privateKeyPath);
  const legacyPassword = typeof raw.password === 'string' && raw.password ? raw.password : undefined;
  const kind = AUTH_KINDS.includes(source.kind)
    ? source.kind
    : legacyKey ? 'key' : legacyPassword ? 'password' : (source.kind ?? (previous?.kind ?? 'agent'));
  if (!AUTH_KINDS.includes(kind)) {
    throw new ConnectionError('AUTH_INVALID', `auth.kind must be one of ${AUTH_KINDS.join(', ')}; got ${String(kind)}`);
  }
  const auth = { kind };
  if (kind === 'key') {
    const keyPath = optionalString(source.privateKeyPath) ?? legacyKey ?? previous?.privateKeyPath;
    if (!keyPath) throw new ConnectionError('AUTH_INVALID', 'auth.kind "key" requires auth.privateKeyPath');
    auth.privateKeyPath = keyPath;
    const passphrase = optionalString(source.passphrase) ?? optionalString(raw.passphrase);
    if (passphrase) auth.passphrase = passphrase;
  } else if (kind === 'password') {
    const password = (typeof source.password === 'string' && source.password) || legacyPassword || previous?.password;
    if (!password) throw new ConnectionError('AUTH_INVALID', 'auth.kind "password" requires auth.password');
    auth.password = password;
  } else {
    const agent = optionalString(source.agent) ?? optionalString(raw.agentSocket);
    if (agent) auth.agent = agent;
  }
  return auth;
}

/**
 * Normalise one connection record.
 *
 * `previous` is the record being replaced (when editing), so an empty password
 * field in the browser keeps the stored secret instead of wiping it.
 */
export function normalizeConnection(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new ConnectionError('CONNECTION_INVALID', 'connection must be an object');
  }
  const previous = options.previous;
  const host = optionalString(raw.host);
  if (!host) throw new ConnectionError('CONNECTION_INVALID', 'connection.host is required');
  const label = optionalString(raw.label) ?? host;
  const id = optionalString(raw.id) ?? slugify(label);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new ConnectionError('CONNECTION_INVALID', `connection.id ${JSON.stringify(id)} must be a slug ([a-z0-9._-])`);
  }
  const port = raw.port === undefined || raw.port === null || raw.port === '' ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionError('CONNECTION_INVALID', `connection.port must be an integer 1-65535; got ${String(raw.port)}`);
  }
  const username = optionalString(raw.username) ?? previous?.username ?? '';
  const remoteRoot = normalizeRemotePath(optionalString(raw.remoteRoot) ?? previous?.remoteRoot ?? '~', { home: '~' });
  const localWorkspaceRaw = optionalString(raw.localWorkspace) ?? previous?.localWorkspace;
  const localWorkspace = localWorkspaceRaw
    ? (isAbsolute(localWorkspaceRaw) ? resolve(localWorkspaceRaw) : localWorkspaceRaw)
    : undefined;
  const connection = {
    id,
    label,
    host,
    port,
    username,
    auth: normalizeAuth(raw, previous?.auth),
    remoteRoot,
    ...(localWorkspace ? { localWorkspace } : {}),
  };
  if (optionalString(raw.hostFingerprint)) connection.hostFingerprint = optionalString(raw.hostFingerprint);
  return connection;
}

export function emptyStore() {
  return { version: 1, connections: [] };
}

export function readStore(config) {
  const file = config.connectionsFile;
  if (!existsSync(file)) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConnectionError('STORE_UNREADABLE', `${file} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.connections;
  if (!Array.isArray(list)) return emptyStore();
  return { version: 1, connections: list.map((entry) => normalizeConnection(entry)) };
}

export function writeStore(config, store) {
  const file = config.connectionsFile;
  mkdirSync(dirname(file), { recursive: true });
  const body = `${JSON.stringify({ version: 1, connections: store.connections }, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, body, { mode: 0o600 });
  renameSync(temp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: chmod is a no-op, the file still lives in the user's profile. */
  }
}

/** Insert or replace a connection, keeping ids unique. */
export function upsertConnection(store, connection) {
  const list = store.connections.slice();
  const index = list.findIndex((entry) => entry.id === connection.id);
  if (index >= 0) list[index] = connection;
  else list.push(connection);
  return { version: 1, connections: list };
}

export function removeConnection(store, id) {
  return { version: 1, connections: store.connections.filter((entry) => entry.id !== id) };
}

export function findConnection(store, id) {
  return store.connections.find((entry) => entry.id === id);
}

/** The only shape that may cross into the browser or a tool result. */
export function toPublicConnection(connection) {
  const { auth, ...rest } = connection;
  return {
    ...rest,
    auth: auth.kind === 'password'
      ? { kind: 'password', hasPassword: true }
      : auth.kind === 'key'
        ? { kind: 'key', privateKeyPath: auth.privateKeyPath, hasPassphrase: Boolean(auth.passphrase) }
        : { kind: 'agent', ...(auth.agent ? { agent: auth.agent } : {}) },
  };
}
