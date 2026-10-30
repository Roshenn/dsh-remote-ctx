/**
 * The panel API: routes, validation and the secret boundary.
 *
 * The handler is exercised directly with fake request/response objects, so no
 * HTTP server is started and the remote side stays the in-memory adapter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from '../lib/api.mjs';
import { RemoteContext } from '../lib/context.mjs';
import { createFakeRemote } from './fake-remote.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-api-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

function makeApi() {
  const fake = createFakeRemote({ home: '/home/tester' });
  fake.mkdir('/home/tester/work/src');
  fake.seed('/home/tester/work/README.md', '# remote\n');
  fake.seed('/home/tester/work/src/app.js', 'export const n = 1;\n');
  const context = new RemoteContext(
    {
      connectionsFile: join(workspace, 'connections.json'),
      indexDir: join(workspace, 'index'),
      connectTimeoutMs: 1000,
      keepaliveIntervalMs: 0,
      idleTtlMs: 60000,
      maxIndexFiles: 100,
      maxIndexDepth: 6,
      maxReadBytes: 65536,
      allowRemoteWrite: true,
    },
    { adapterFor: () => fake.adapter },
  );
  return { fake, context, handler: createApiHandler(context) };
}

function invoke(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = {
      method,
      url,
      on(event, callback) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(callback);
        return req;
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(payload) {
        try {
          resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(payload) });
        } catch (error) {
          reject(error);
        }
      },
    };
    handler(req, res).catch(reject);
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    process.nextTick(() => {
      for (const chunk of chunks) for (const callback of listeners.get('data') ?? []) callback(chunk);
      for (const callback of listeners.get('end') ?? []) callback();
    });
  });
}

test('the state route lists connections and index summaries', async () => {
  const { handler } = makeApi();
  const empty = await invoke(handler, 'GET', '/remote-ctx/api/state');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.connections, []);

  const created = await invoke(handler, 'POST', '/remote-ctx/api/connections', {
    connection: { id: 'lan', label: 'LAN', host: '10.0.0.5', password: 'hunter2', remoteRoot: '/home/tester/work' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.data.connection.auth.hasPassword, true);
  assert.equal(JSON.stringify(created.body).includes('hunter2'), false);

  const state = await invoke(handler, 'GET', '/remote-ctx/api/state');
  assert.equal(state.body.data.connections.length, 1);
  assert.equal(state.body.data.indexes.lan.files, 0);
});

test('browse lists the remote root and the configured directory', async () => {
  const { handler } = makeApi();
  await invoke(handler, 'POST', '/remote-ctx/api/connections', {
    connection: { id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work' },
  });
  const root = await invoke(handler, 'GET', '/remote-ctx/api/browse?id=lan');
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.data.entries.map((entry) => entry.name), ['src', 'README.md']);
  const nested = await invoke(handler, 'GET', '/remote-ctx/api/browse?id=lan&path=src');
  assert.deepEqual(nested.body.data.entries.map((entry) => entry.name), ['app.js']);
});

test('a path outside the root is a 400 with the path error code', async () => {
  const { handler } = makeApi();
  await invoke(handler, 'POST', '/remote-ctx/api/connections', {
    connection: { id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work' },
  });
  const escaped = await invoke(handler, 'GET', '/remote-ctx/api/browse?id=lan&path=%2Fetc');
  assert.equal(escaped.status, 400);
  assert.equal(escaped.body.error.code, 'REMOTE_PATH_OUTSIDE_ROOT');
});

test('index builds a summary that state then reports', async () => {
  const { handler } = makeApi();
  await invoke(handler, 'POST', '/remote-ctx/api/connections', {
    connection: { id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work' },
  });
  const built = await invoke(handler, 'POST', '/remote-ctx/api/index', { id: 'lan' });
  assert.equal(built.status, 200);
  assert.equal(built.body.data.summary.files, 2);
  assert.equal(built.body.data.summary.dirs, 1);
});

test('sync with dryRun plans but writes nothing', async () => {
  const { handler, fake } = makeApi();
  await invoke(handler, 'POST', '/remote-ctx/api/connections', {
    connection: { id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work' },
  });
  const localRoot = join(workspace, 'ws');
  mkdirSync(join(localRoot, 'docs'), { recursive: true });
  writeFileSync(join(localRoot, 'docs', 'notes.md'), 'local\n');

  const preview = await invoke(handler, 'POST', '/remote-ctx/api/sync', { id: 'lan', direction: 'push', localRoot, dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.plan.pending, 1);
  assert.equal(fake.read('/home/tester/work/docs/notes.md'), undefined);
});

test('unknown routes and missing ids fail cleanly', async () => {
  const { handler } = makeApi();
  const missing = await invoke(handler, 'GET', '/remote-ctx/api/browse');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'id-missing');
  const unknown = await invoke(handler, 'GET', '/remote-ctx/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'not-found');
});
