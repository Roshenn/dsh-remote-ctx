/**
 * Mirror planning and application: local disk <-> remote adapter.
 *
 * Uses a real temp directory for the local side and the in-memory adapter for
 * the remote side, so the comparison rules and the atomic-ish write path run
 * for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteFs } from '../lib/remote-fs.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { applyPull, applyPush, normalizeRelative, planPull, planPush, walkLocal } from '../lib/mirror.mjs';
import { createFakeRemote } from './fake-remote.mjs';

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-mirror-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

function writeLocal(relative, content) {
  const absolute = join(root, ...relative.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function makeRemote() {
  const fake = createFakeRemote({ home: '/home/tester' });
  fake.mkdir('/home/tester/work');
  const connection = { id: 'test', remoteRoot: '/home/tester/work', auth: { kind: 'agent' } };
  const fs = new RemoteFs({
    connection,
    adapter: fake.adapter,
    home: fake.home,
    config: { maxIndexDepth: 8, maxIndexFiles: 100, maxReadBytes: 65536, allowRemoteWrite: true },
  });
  return { fake, fs };
}

test('walkLocal lists files, skips ignored dirs, and uses POSIX relative paths', async () => {
  writeLocal('README.md', '# hi\n');
  writeLocal('src/app.js', 'console.log(1)\n');
  writeLocal('node_modules/pkg/index.js', 'ignored\n');
  writeLocal('.git/config', 'ignored\n');

  const walk = await walkLocal(root, { maxDepth: 6, maxFiles: 100 });
  const files = walk.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path);
  assert.deepEqual(files, ['README.md', 'src/app.js']);
  assert.ok(walk.entries.some((entry) => entry.path === 'src' && entry.type === 'dir'));
  assert.equal(walk.truncated, false);
});

test('planPush uploads missing files and skips equal sizes', async () => {
  const { fake, fs } = makeRemote();
  fake.seed('/home/tester/work/README.md', '# hi\n');
  const index = await buildIndex(fs);
  const local = await walkLocal(root, { maxDepth: 6, maxFiles: 100 });

  const plan = planPush(local, index);
  const uploads = plan.uploads.map((row) => row.path);
  assert.deepEqual(uploads, ['src/app.js']);
  assert.deepEqual(plan.skipped.map((row) => row.path), ['README.md']);
  assert.equal(plan.direction, 'push');
});

test('planPush re-uploads a size change and honours force', async () => {
  const { fake, fs } = makeRemote();
  fake.seed('/home/tester/work/README.md', '# different content, different size\n');
  const index = await buildIndex(fs);
  const local = await walkLocal(root, { maxDepth: 6, maxFiles: 100 });
  assert.deepEqual(planPush(local, index).uploads.map((row) => row.path), ['README.md', 'src/app.js']);
  assert.equal(planPush(local, index, { force: true }).uploads.length, 2);
});

test('applyPush writes the remote tree', async () => {
  const { fake, fs } = makeRemote();
  const index = await buildIndex(fs);
  const local = await walkLocal(root, { maxDepth: 6, maxFiles: 100 });
  const plan = planPush(local, index);
  const applied = await applyPush(fs, plan, { localRoot: root });
  assert.equal(applied.failed.length, 0);
  assert.equal(applied.ok.length, 2);
  assert.equal(fake.read('/home/tester/work/src/app.js'), 'console.log(1)\n');
});

test('planPull and applyPull bring remote files down', async () => {
  const { fake, fs } = makeRemote();
  fake.seed('/home/tester/work/remote-only.md', 'from the remote\n');
  const index = await buildIndex(fs);
  const local = await walkLocal(root, { maxDepth: 6, maxFiles: 100 });
  const plan = planPull(index, local);
  assert.deepEqual(plan.downloads.map((row) => row.path), ['remote-only.md']);

  const applied = await applyPull(fs, plan, { localRoot: root });
  assert.equal(applied.failed.length, 0);
  assert.equal(readFileSync(join(root, 'remote-only.md'), 'utf8'), 'from the remote\n');
});

test('normalizeRelative unifies separators', () => {
  assert.equal(normalizeRelative('src\\app.js'), 'src/app.js');
  assert.equal(normalizeRelative('./src/app.js'), 'src/app.js');
});
