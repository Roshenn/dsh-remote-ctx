/**
 * Indexer: walk, cache, path/name search, content search.
 *
 * Runs against the in-memory adapter, so the real `RemoteFs` walker and the
 * real SFTP-error behaviour (a missing directory is an error row, not a throw)
 * are both exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteFs } from '../lib/remote-fs.mjs';
import {
  buildIndex,
  globToRegExp,
  loadIndex,
  looksTextual,
  saveIndex,
  searchContent,
  searchIndex,
  summarizeIndex,
} from '../lib/indexer.mjs';
import { createFakeRemote } from './fake-remote.mjs';

const config = { maxIndexDepth: 8, maxIndexFiles: 500, maxReadBytes: 65536, allowRemoteWrite: true };

function makeRemote(seed = true) {
  const fake = createFakeRemote({ home: '/home/tester' });
  if (seed) {
    fake.seed('/home/tester/work/README.md', '# workspace\nhello remote context\n');
    fake.seed('/home/tester/work/src/app.js', 'export const answer = 42;\n');
    fake.seed('/home/tester/work/src/util.ts', 'export function hello() { return "hi"; }\n');
    fake.seed('/home/tester/work/docs/guide.md', 'guide\ncontext lives here\n');
    fake.seed('/home/tester/work/node_modules/pkg/index.js', 'ignored\n');
    fake.seed('/home/tester/work/.git/config', 'ignored\n');
  }
  const connection = { id: 'test', remoteRoot: '/home/tester/work', auth: { kind: 'agent' } };
  const fs = new RemoteFs({ connection, adapter: fake.adapter, home: fake.home, config });
  return { fake, fs };
}

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-index-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

test('globToRegExp supports *, ** and ?', () => {
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(!globToRegExp('*.md').test('src/README.md'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/util.ts'));
  assert.ok(globToRegExp('?.js').test('a.js'));
  assert.ok(!globToRegExp('?.js').test('ab.js'));
});

test('looksTextual keeps code and prose, drops binaries and huge files', () => {
  assert.ok(looksTextual('src/app.js', 100));
  assert.ok(looksTextual('README', 100));
  assert.ok(looksTextual('.gitignore', 10));
  assert.ok(!looksTextual('logo.png', 100));
  assert.ok(!looksTextual('huge.md', 1024 * 1024));
});

test('buildIndex walks, skips ignored directories, and counts', async () => {
  const { fs } = makeRemote();
  const index = await buildIndex(fs);
  const paths = index.entries.map((entry) => entry.path);
  assert.deepEqual(paths, ['README.md', 'docs', 'docs/guide.md', 'src', 'src/app.js', 'src/util.ts']);
  assert.deepEqual(index.counts, { files: 4, dirs: 2, bytes: index.entries.filter((e) => e.type === 'file').reduce((sum, e) => sum + e.size, 0) });
  assert.equal(index.truncated, false);
  assert.equal(index.connectionId, 'test');
});

test('buildIndex stops at maxFiles and says so', async () => {
  const { fs } = makeRemote();
  const index = await buildIndex(fs, { maxFiles: 2 });
  assert.equal(index.entries.length, 2);
  assert.equal(index.truncated, true);
});

test('searchIndex matches paths, names and globs', async () => {
  const { fs } = makeRemote();
  const index = await buildIndex(fs);
  const byPath = searchIndex(index, { query: 'src' });
  assert.deepEqual(byPath.entries.map((entry) => entry.path), ['src', 'src/app.js', 'src/util.ts']);
  const byName = searchIndex(index, { query: 'util', mode: 'name' });
  assert.deepEqual(byName.entries.map((entry) => entry.path), ['src/util.ts']);
  const globbed = searchIndex(index, { query: '**/*.md' });
  assert.deepEqual(globbed.entries.map((entry) => entry.path), ['README.md', 'docs/guide.md']);
  const filesOnly = searchIndex(index, { query: 'src', type: 'file' });
  assert.deepEqual(filesOnly.entries.map((entry) => entry.path), ['src/app.js', 'src/util.ts']);
});

test('searchContent reads plausible files and reports line hits', async () => {
  const { fs } = makeRemote();
  const index = await buildIndex(fs);
  const result = await searchContent(fs, index, { query: 'context' });
  assert.equal(result.filesScanned, 4);
  assert.deepEqual(result.hits.map((hit) => `${hit.path}:${hit.line}`), ['README.md:2', 'docs/guide.md:2']);
});

test('saveIndex/loadIndex round-trip and summarise', async () => {
  const { fs } = makeRemote();
  const index = await buildIndex(fs);
  saveIndex(workspace, index);
  const loaded = loadIndex(workspace, 'test');
  assert.equal(loaded.entries.length, index.entries.length);
  const summary = summarizeIndex(loaded);
  assert.equal(summary.files, 4);
  assert.equal(summary.dirs, 2);
  assert.ok(summary.ageMs >= 0);
  assert.equal(loadIndex(workspace, 'missing'), undefined);
});

test('a directory that cannot be listed becomes an error row, not a failure', async () => {
  const { fs, fake } = makeRemote();
  const original = fake.adapter.list;
  fake.adapter.list = async (path) => {
    if (path.endsWith('/docs')) {
      const error = new Error('permission denied');
      error.code = 3;
      throw error;
    }
    return original(path);
  };
  const index = await buildIndex(fs);
  assert.equal(index.errors.length, 1);
  assert.match(index.errors[0].path, /docs$/);
});
