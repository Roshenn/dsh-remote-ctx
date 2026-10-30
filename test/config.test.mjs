/**
 * Connection records: the normalisation rules, the secret boundary, and the
 * on-disk store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectionError,
  emptyStore,
  findConnection,
  normalizeConnection,
  readStore,
  removeConnection,
  resolveConfig,
  toPublicConnection,
  upsertConnection,
  writeStore,
} from '../lib/config.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-config-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

test('resolveConfig fills defaults under DSH_HOME', () => {
  const config = resolveConfig({}, { DSH_HOME: workspace });
  assert.equal(config.connectionsFile, join(workspace, 'remote-ctx', 'connections.json'));
  assert.equal(config.indexDir, join(workspace, 'remote-ctx', 'index'));
  assert.equal(config.connectTimeoutMs, 15000);
  assert.equal(config.allowRemoteWrite, true);
  assert.equal(config.maxReadBytes, 262144);
});

test('resolveConfig clamps bad numbers and honours allowRemoteWrite: false', () => {
  const config = resolveConfig({ connectTimeoutMs: 10, maxIndexFiles: -1, allowRemoteWrite: false }, { DSH_HOME: workspace });
  assert.equal(config.connectTimeoutMs, 15000);
  assert.equal(config.maxIndexFiles, 20000);
  assert.equal(config.allowRemoteWrite, false);
});

test('normalizeConnection derives an id, defaults the port, and normalises auth', () => {
  const connection = normalizeConnection({ label: 'Lecoo LAN', host: '192.168.1.20', privateKeyPath: '/keys/id_ed25519' });
  assert.equal(connection.id, 'lecoo-lan');
  assert.equal(connection.port, 22);
  assert.equal(connection.remoteRoot, '~');
  assert.deepEqual(connection.auth, { kind: 'key', privateKeyPath: '/keys/id_ed25519' });
});

test('normalizeConnection keeps an explicit password out of the public view', () => {
  const connection = normalizeConnection({ id: 'c1', host: 'h', password: 'hunter2' });
  assert.equal(connection.auth.kind, 'password');
  assert.equal(connection.auth.password, 'hunter2');
  const publicView = toPublicConnection(connection);
  assert.equal(publicView.auth.hasPassword, true);
  assert.equal(JSON.stringify(publicView).includes('hunter2'), false);
});

test('normalizeConnection validates host, port, id and auth', () => {
  assert.throws(() => normalizeConnection({}), ConnectionError);
  assert.throws(() => normalizeConnection({ host: 'h', port: 70000 }), ConnectionError);
  assert.throws(() => normalizeConnection({ host: 'h', id: 'bad id!' }), ConnectionError);
  assert.throws(() => normalizeConnection({ host: 'h', auth: { kind: 'key' } }), ConnectionError);
  assert.throws(() => normalizeConnection({ host: 'h', auth: { kind: 'password' } }), ConnectionError);
  assert.throws(() => normalizeConnection({ host: 'h', auth: { kind: 'magic' } }), ConnectionError);
});

test('editing without resending a password keeps the stored one', () => {
  const previous = normalizeConnection({ id: 'c1', host: 'h', password: 'hunter2' });
  const edited = normalizeConnection({ id: 'c1', host: 'h2', auth: toPublicConnection(previous).auth }, { previous });
  assert.equal(edited.host, 'h2');
  assert.equal(edited.auth.password, 'hunter2');
});

test('editing a key connection without a passphrase keeps the stored one', () => {
  const previous = normalizeConnection({ id: 'k', host: 'h', auth: { kind: 'key', privateKeyPath: '/keys/id', passphrase: 's3cret' } });
  const edited = normalizeConnection({ id: 'k', host: 'h2', auth: toPublicConnection(previous).auth }, { previous });
  assert.equal(edited.auth.passphrase, 's3cret');
});

test('the store round-trips through a 0600 file', () => {
  const config = resolveConfig({ connectionsFile: join(workspace, 'nested', 'connections.json') }, { DSH_HOME: workspace });
  const connection = normalizeConnection({ id: 'c1', host: 'h', auth: { kind: 'agent' } });
  const store = upsertConnection(emptyStore(), connection);
  writeStore(config, store);
  const reloaded = readStore(config);
  assert.equal(reloaded.connections.length, 1);
  assert.equal(reloaded.connections[0].host, 'h');
  if (process.platform !== 'win32') {
    assert.equal(statSync(config.connectionsFile).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(config.connectionsFile, 'utf8')).connections.length, 1);
});

test('upsert replaces by id and remove drops by id', () => {
  const first = normalizeConnection({ id: 'c1', host: 'a', auth: { kind: 'agent' } });
  const second = normalizeConnection({ id: 'c2', host: 'b', auth: { kind: 'agent' } });
  let store = upsertConnection(emptyStore(), first);
  store = upsertConnection(store, second);
  assert.equal(store.connections.length, 2);
  store = upsertConnection(store, normalizeConnection({ id: 'c1', host: 'a2', auth: { kind: 'agent' } }));
  assert.equal(store.connections.length, 2);
  assert.equal(findConnection(store, 'c1').host, 'a2');
  store = removeConnection(store, 'c1');
  assert.equal(store.connections.length, 1);
  assert.equal(findConnection(store, 'c1'), undefined);
});

test('readStore tolerates a missing file and rejects invalid JSON', () => {
  const config = resolveConfig({ connectionsFile: join(workspace, 'absent.json') }, { DSH_HOME: workspace });
  assert.deepEqual(readStore(config).connections, []);
  const bad = join(workspace, 'bad.json');
  writeFileSync(bad, '{ nope');
  assert.throws(() => readStore({ ...config, connectionsFile: bad }), ConnectionError);
});
