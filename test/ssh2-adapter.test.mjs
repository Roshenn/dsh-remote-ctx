/**
 * Error wording: ssh2's generic auth failure must become a message that names
 * the target, the method that was tried, and the one check that usually fixes
 * it. Pure functions, so this runs in CI where ssh2 is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authMethodOf,
  describeAuthFailure,
  describeKeyFailure,
  targetOf,
  translateConnectError,
} from '../lib/ssh2-adapter.mjs';

const base = { id: 'c1', host: '10.1.64.4', port: 22, username: 'root' };

test('targetOf and authMethodOf describe a connection in human terms', () => {
  assert.equal(targetOf(base), 'root@10.1.64.4:22');
  assert.equal(targetOf({ ...base, username: undefined }), '10.1.64.4:22');
  assert.equal(authMethodOf({ ...base, auth: { kind: 'key', privateKeyPath: '/k/id' } }), 'private key /k/id');
  assert.equal(authMethodOf({ ...base, auth: { kind: 'password', password: 'x' } }), 'password');
  assert.equal(authMethodOf({ ...base, auth: { kind: 'agent' } }), 'ssh-agent');
});

test('a rejected key names the key, the target and the fix', () => {
  const message = describeAuthFailure({ ...base, auth: { kind: 'key', privateKeyPath: 'C:\\keys\\id_ed25519' } });
  assert.match(message, /root@10\.1\.64\.4:22/);
  assert.match(message, /private key C:\\keys\\id_ed25519/);
  assert.match(message, /authorized_keys/);
  assert.match(message, /password auth/);
});

test('a rejected password points at the password and the server policy', () => {
  const message = describeAuthFailure({ ...base, auth: { kind: 'password', password: 'secret' } });
  assert.match(message, /password/);
  assert.match(message, /server allows password auth/);
  // The secret must never appear in an error string.
  assert.equal(message.includes('secret'), false);
});

test('agent auth failure suggests loading a key', () => {
  const message = describeAuthFailure({ ...base, auth: { kind: 'agent' } });
  assert.match(message, /agent/);
});

test('key failures are classified: missing file, passphrase, unparseable', () => {
  const connection = { ...base, auth: { kind: 'key', privateKeyPath: 'C:\\keys\\id_ed25519' } };
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  assert.match(describeKeyFailure(connection, missing), /not found/);
  assert.match(describeKeyFailure(connection, new Error('Encrypted private OpenSSH key detected')), /密钥口令/);
  assert.match(describeKeyFailure(connection, new Error('bad base64')), /could not be read/);
});

test('translateConnectError maps ssh2 wording onto codes and hints', () => {
  const connection = { ...base, auth: { kind: 'key', privateKeyPath: '/k/id' } };
  const auth = translateConnectError(connection, new Error('All configured authentication methods failed'));
  assert.equal(auth.code, 'SSH_AUTH_FAILED');
  assert.match(auth.message, /authorized_keys/);

  const key = translateConnectError(connection, new Error('Cannot parse privateKey: bad'));
  assert.equal(key.code, 'SSH_KEY_UNREADABLE');

  const network = translateConnectError(connection, new Error('connect ECONNREFUSED 1.2.3.4:22'));
  assert.equal(network.code, 'SSH_CONNECT_FAILED');
  assert.match(network.message, /root@10\.1\.64\.4:22/);
});
