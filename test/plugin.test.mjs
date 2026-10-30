/**
 * Plugin wiring: the cordis contract, the seven tools, and one end-to-end pass
 * through every layer (tool -> context -> RemoteFs -> adapter).
 *
 * `@deepseek-ai/dsh-tools` is a peer dependency supplied by the harness, so the
 * test swaps in a contract stub through a loader hook; the remote side is the
 * in-memory adapter passed as the second `apply()` option.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { createFakeRemote } from './fake-remote.mjs';

register('./stub/loader.mjs', import.meta.url);
const plugin = await import('../lib/index.js');

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-plugin-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

const SSH_CONFIG = join(workspace, 'ssh-config');
writeFileSync(SSH_CONFIG, 'Host workstation\n  HostName 10.1.2.3\n  User dev\n');

let stackSeq = 0;

function makeStack() {
  // A per-test store: the plugin persists connections to disk.
  const dir = join(workspace, `stack-${stackSeq += 1}`);
  mkdirSync(dir, { recursive: true });
  const fake = createFakeRemote({ home: '/home/tester' });
  fake.mkdir('/home/tester/work/src');
  fake.seed('/home/tester/work/README.md', '# remote workspace\n');
  fake.seed('/home/tester/work/src/app.js', 'export const answer = 42;\n');

  const config = {
    connectionsFile: join(dir, 'connections.json'),
    indexDir: join(dir, 'index'),
    sshConfigFile: SSH_CONFIG,
    workspacesDir: join(dir, 'workspaces'),
    allowRemoteWrite: true,
  };
  const registry = { created: [], async create(path, title) { this.created.push({ path, title }); return { id: 'w1', path, title }; } };
  const registered = new Map();
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
  };
  plugin.apply(ctx, config, { adapterFor: () => fake.adapter, registry: () => registry });
  const call = async (name, args = {}) => {
    const definition = registered.get(name);
    if (!definition) throw new Error(`tool ${name} is not registered`);
    return definition.execute(args, { agent: {}, signal: new AbortController().signal });
  };
  return { fake, registered, registry, call };
}

test('plugin exports the cordis contract', () => {
  assert.equal(plugin.name, 'dsh-remote-ctx');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the seven remote_ctx_* tools', () => {
  const { registered } = makeStack();
  assert.deepEqual([...registered.keys()].sort(), [
    'remote_ctx_connections',
    'remote_ctx_find',
    'remote_ctx_index',
    'remote_ctx_ls',
    'remote_ctx_read',
    'remote_ctx_sync',
    'remote_ctx_workspace',
    'remote_ctx_write',
  ]);
});

test('a connection can be added, listed, and never echoes the password', async () => {
  const { call } = makeStack();
  const added = await call('remote_ctx_connections', {
    action: 'add',
    id: 'lan',
    label: 'LAN box',
    host: '192.168.1.20',
    username: 'tester',
    password: 'hunter2',
    remoteRoot: '/home/tester/work',
  });
  assert.equal(added.ok, true);
  assert.match(added.text, /LAN box/);
  assert.equal(added.text.includes('hunter2'), false);

  const listed = await call('remote_ctx_connections', { action: 'list' });
  assert.match(listed.text, /192\.168\.1\.20:22/);
  assert.equal(listed.text.includes('hunter2'), false);
});

test('ls, read and write go through the remote adapter', async () => {
  const { fake, call } = makeStack();
  await call('remote_ctx_connections', {
    action: 'add', id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work',
  });

  const listing = await call('remote_ctx_ls', { connection: 'lan' });
  assert.match(listing.text, /README\.md/);
  assert.match(listing.text, /src/);

  const read = await call('remote_ctx_read', { connection: 'lan', path: 'src/app.js' });
  assert.match(read.text, /answer = 42/);

  const write = await call('remote_ctx_write', {
    connection: 'lan', path: 'src/new.js', content: 'export const created = true;\n',
  });
  assert.equal(write.ok, true);
  assert.equal(fake.read('/home/tester/work/src/new.js'), 'export const created = true;\n');
});

test('paths outside the remote root are refused before touching the adapter', async () => {
  const { call } = makeStack();
  await call('remote_ctx_connections', {
    action: 'add', id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work',
  });
  await assert.rejects(() => call('remote_ctx_read', { connection: 'lan', path: '/etc/passwd' }), /escapes the connection root/);
  await assert.rejects(() => call('remote_ctx_write', { connection: 'lan', path: '../escape.txt', content: 'x' }), /escapes the connection root/);
});

test('index then find searches the cached index', async () => {
  const { call } = makeStack();
  await call('remote_ctx_connections', {
    action: 'add', id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work',
  });
  const indexed = await call('remote_ctx_index', { connection: 'lan' });
  assert.match(indexed.text, /2 files/);

  const found = await call('remote_ctx_find', { connection: 'lan', query: 'app', mode: 'name' });
  assert.match(found.text, /src\/app\.js/);

  const content = await call('remote_ctx_find', { connection: 'lan', query: 'answer', mode: 'content' });
  assert.match(content.text, /src\/app\.js/);
});

test('discover lists ~/.ssh/config hosts, and import creates one connection', async () => {
  const { call } = makeStack();
  const discovered = await call('remote_ctx_connections', { action: 'discover' });
  assert.equal(discovered.ok, true);
  assert.match(discovered.text, /workstation/);
  assert.equal(discovered.hosts.length, 1);
  assert.equal(discovered.hosts[0].hostName, '10.1.2.3');

  const imported = await call('remote_ctx_connections', { action: 'import', host: 'workstation' });
  assert.equal(imported.ok, true);
  assert.match(imported.text, /imported `workstation`/);

  const listed = await call('remote_ctx_connections', { action: 'list' });
  assert.match(listed.text, /workstation/);
  assert.match(listed.text, /10\.1\.2\.3/);
});

test('creates a workspace for a remote directory', async () => {
  const { registered, registry, call } = makeStack();
  await call('remote_ctx_connections', {
    action: 'add', id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work',
  });
  assert.ok(registered.has('remote_ctx_workspace'));

  const created = await call('remote_ctx_workspace', { connection: 'lan', path: 'src' });
  assert.equal(created.ok, true);
  assert.match(created.text, /workspace registered/);
  assert.match(created.workspacePath, /workspaces/);
  assert.equal(registry.created.length, 1);
  assert.equal(registry.created[0].path, created.workspacePath);
});

test('sync push mirrors a local directory onto the remote, dry run first', async () => {
  const { fake, call } = makeStack();
  await call('remote_ctx_connections', {
    action: 'add', id: 'lan', host: 'h', password: 'p', remoteRoot: '/home/tester/work',
  });

  const localRoot = join(workspace, 'ws');
  mkdirSync(join(localRoot, 'docs'), { recursive: true });
  writeFileSync(join(localRoot, 'docs', 'notes.md'), 'local notes\n');

  const preview = await call('remote_ctx_sync', { connection: 'lan', direction: 'push', localRoot, dryRun: true });
  assert.match(preview.text, /dry run/);
  assert.equal(fake.read('/home/tester/work/docs/notes.md'), undefined);

  const applied = await call('remote_ctx_sync', { connection: 'lan', direction: 'push', localRoot });
  assert.equal(applied.ok, true);
  assert.equal(fake.read('/home/tester/work/docs/notes.md'), 'local notes\n');
});
