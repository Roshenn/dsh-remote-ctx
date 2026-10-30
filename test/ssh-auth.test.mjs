/**
 * Real-socket auth tests against an in-process ssh2 server.
 *
 * These prove the adapter's auth paths end to end: correct password, rejected
 * password, keyboard-interactive-only servers, and private-key auth. SFTP is
 * refused by the test server on purpose — reaching `SSH_SFTP_UNAVAILABLE` means
 * authentication succeeded, which is exactly what is being tested.
 *
 * The suite is skipped when `ssh2` is not installed: the package's own tests run
 * with no dependencies, and CI has no node_modules by design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSsh2Adapter } from '../lib/ssh2-adapter.mjs';

let ssh2;
try {
  // CJS package: the constructors live on the default export.
  const mod = await import('ssh2');
  ssh2 = mod.default ?? mod;
} catch {
  ssh2 = undefined;
}
const skip = ssh2 ? false : 'ssh2 is not installed (dependencies are optional for the offline suite)';

const config = {
  connectTimeoutMs: 5000,
  keepaliveIntervalMs: 0,
  maxReadBytes: 1024,
  allowRemoteWrite: true,
  maxIndexDepth: 4,
  maxIndexFiles: 100,
};

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-auth-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * One server with three modes:
 *   'password'  — accepts password and publickey
 *   'keyboard'  — rejects the password method, accepts keyboard-interactive
 *   'publickey' — accepts publickey only
 */
function startServer(mode = 'password') {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (mode === 'keyboard') {
        if (ctx.method === 'keyboard-interactive') {
          return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
            if (answers[0] === 's3cret') ctx.accept();
            else ctx.reject(['keyboard-interactive']);
          });
        }
        return ctx.reject(['keyboard-interactive']);
      }
      if (mode === 'publickey') {
        if (ctx.method === 'publickey') return ctx.accept();
        return ctx.reject(['publickey']);
      }
      if (ctx.method === 'password' && ctx.password === 's3cret') return ctx.accept();
      if (ctx.method === 'publickey') return ctx.accept();
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        // Auth succeeded; refusing SFTP is the signal the tests look for.
        session.on('sftp', (_acceptSftp, rejectSftp) => rejectSftp());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function withServer(mode, run) {
  const { server, port } = await startServer(mode);
  try {
    return await run(port);
  } finally {
    server.close();
  }
}

function connection(port, auth, extra = {}) {
  return { id: 'auth-test', host: '127.0.0.1', port, username: 'tester', remoteRoot: '~', auth, ...extra };
}

async function expectCode(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}, but the call resolved`);
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
}

test('password auth succeeds and then lands on the SFTP check', { skip }, async () => {
  await withServer('password', async (port) => {
    await expectCode(
      createSsh2Adapter(connection(port, { kind: 'password', password: 's3cret' }), config),
      'SSH_SFTP_UNAVAILABLE',
    );
  });
});

test('a rejected password becomes SSH_AUTH_FAILED with an actionable message', { skip }, async () => {
  await withServer('password', async (port) => {
    const error = await expectCode(
      createSsh2Adapter(connection(port, { kind: 'password', password: 'wrong' }), config),
      'SSH_AUTH_FAILED',
    );
    assert.match(error.message, /authentication failed/);
    assert.match(error.message, /tester@127\.0\.0\.1/);
    assert.match(error.message, /password/);
    // The secret must never be echoed back into an error message.
    assert.equal(error.message.includes('wrong'), false);
  });
});

test('a keyboard-interactive-only server is answered with the stored password', { skip }, async () => {
  await withServer('keyboard', async (port) => {
    await expectCode(
      createSsh2Adapter(connection(port, { kind: 'password', password: 's3cret' }), config),
      'SSH_SFTP_UNAVAILABLE',
    );
  });
});

test('private-key auth succeeds from a key file on disk', { skip }, async () => {
  const keyPath = join(workspace, 'id_test');
  writeFileSync(keyPath, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }));
  await withServer('publickey', async (port) => {
    await expectCode(
      createSsh2Adapter(connection(port, { kind: 'key', privateKeyPath: keyPath }), config),
      'SSH_SFTP_UNAVAILABLE',
    );
  });
});

test('a missing key file fails before any connection is attempted', { skip }, async () => {
  const error = await expectCode(
    createSsh2Adapter(connection(22, { kind: 'key', privateKeyPath: join(workspace, 'absent') }), config),
    'SSH_KEY_UNREADABLE',
  );
  assert.match(error.message, /not found/);
});

test('a rejected key names the key and the fix', { skip }, async () => {
  const keyPath = join(workspace, 'id_rejected');
  writeFileSync(keyPath, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }));
  await withServer('keyboard', async (port) => {
    const error = await expectCode(
      createSsh2Adapter(connection(port, { kind: 'key', privateKeyPath: keyPath }), config),
      'SSH_AUTH_FAILED',
    );
    assert.match(error.message, /authorized_keys/);
  });
});
