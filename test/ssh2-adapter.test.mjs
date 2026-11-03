/**
 * Error wording: ssh2's generic auth failure must become a message that names
 * the target, the method that was tried, and the one check that usually fixes
 * it. Pure functions, so this runs in CI where ssh2 is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  agentSocketOf,
  authMethodOf,
  connectAndWait,
  describeAuthFailure,
  describeKeyFailure,
  expandEnv,
  targetOf,
  translateConnectError,
} from '../lib/ssh2-adapter.mjs';

const base = { id: 'c1', host: '10.1.64.4', port: 22, username: 'root' };

/** A stand-in for ssh2's Client: only the events and two methods the wait uses. */
function fakeClient() {
  const client = new EventEmitter();
  client.ended = false;
  client.end = () => {
    client.ended = true;
  };
  client.connect = () => {};
  return client;
}

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

test('a host key that no longer matches the pin is an actionable change error', () => {
  const connection = { ...base, hostFingerprint: 'SHA256:old' };
  const changed = translateConnectError(connection, new Error('Host denied (verification failed)'), 'SHA256:new');
  assert.equal(changed.code, 'SSH_HOST_KEY_CHANGED');
  assert.match(changed.message, /SHA256:old/);
  assert.match(changed.message, /SHA256:new/);
  assert.match(changed.message, /re-pin/);
});

test('agent sockets expand env vars and fall back to SSH_AUTH_SOCK', () => {
  const env = { SSH_AUTH_SOCK: '/tmp/agent.sock', HOME: '/home/demo' };
  assert.equal(expandEnv('$SSH_AUTH_SOCK', env), '/tmp/agent.sock');
  assert.equal(expandEnv('${HOME}/agent.sock', env), '/home/demo/agent.sock');
  assert.equal(expandEnv('$NOT_SET', env), '');
  assert.equal(expandEnv('/fixed/agent.sock', env), '/fixed/agent.sock');

  const agentConnection = { ...base, auth: { kind: 'agent', agent: '$SSH_AUTH_SOCK' } };
  assert.equal(agentSocketOf(agentConnection, env), '/tmp/agent.sock');
  assert.equal(agentSocketOf({ ...base, auth: { kind: 'agent' } }, env), '/tmp/agent.sock');
  assert.equal(agentSocketOf({ ...base, auth: { kind: 'agent', agent: '$NOT_SET' } }, { SSH_AUTH_SOCK: '/tmp/fallback.sock' }), '/tmp/fallback.sock');
  assert.equal(agentSocketOf({ ...base, auth: { kind: 'agent', agent: '$NOT_SET' } }, {}), undefined);
});

test('a second ssh2 error never escapes as an uncaught exception', async () => {
  // ssh2 emits the agent error and then "All configured authentication methods
  // failed"; `once('error')` used to leave the second one unheard and the host
  // process died with `fatal uncaught exception` — the app crash this covers.
  const connection = { ...base, auth: { kind: 'agent', agent: '$SSH_AUTH_SOCK' } };
  const client = fakeClient();
  client.connect = () => {
    setTimeout(() => client.emit('error', Object.assign(new Error('connect ENOENT $SSH_AUTH_SOCK'), { level: 'agent' })), 0);
    setTimeout(() => client.emit('error', new Error('All configured authentication methods failed')), 1);
  };

  await assert.rejects(connectAndWait(client, connection, {}), (error) => error.code === 'SSH_AGENT_UNREACHABLE');
  assert.doesNotThrow(() => client.emit('error', new Error('late')));
  assert.equal(client.ended, true);
});

test('a ready client resolves once and still swallows later errors', async () => {
  const client = fakeClient();
  client.connect = () => client.emit('ready');
  await connectAndWait(client, base, {});
  assert.doesNotThrow(() => client.emit('error', new Error('keepalive')));
});

test('a synchronous connect throw becomes a connect error, not an unhandled rejection', async () => {
  const client = fakeClient();
  client.connect = () => {
    throw new Error('invalid config');
  };
  await assert.rejects(connectAndWait(client, base, {}), (error) => error.code === 'SSH_CONNECT_FAILED');
});
