/**
 * Remote `@file` completion: ranking, budgets, caching and the seam overlay.
 *
 * The remote side is a plain object here — `listDir` is injected, so every rule
 * below is exercised without an SSH server, exactly like the rest of the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  RemoteWorkspaceIndex,
  createRemoteFileReference,
  installFileReferenceOverlay,
  isSafeRelativeDir,
  rankCandidates,
} from '../lib/file-reference.mjs';

/** A tree keyed by workspace-relative directory; records every listing. */
function makeTree(tree) {
  const calls = [];
  return {
    calls,
    async listDir(relative) {
      calls.push(relative);
      if (!Object.hasOwn(tree, relative)) throw new Error(`no such remote directory: ${relative}`);
      return tree[relative];
    },
  };
}

/** Let pending microtasks and one macrotask settle: a background walk finishes. */
async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const SAMPLE = {
  '': [
    { name: 'src', kind: 'directory' },
    { name: 'README.md', kind: 'file' },
    { name: '.env', kind: 'file' },
    { name: 'node_modules', kind: 'directory' },
  ],
  src: [
    { name: 'app.js', kind: 'file' },
    { name: 'main.c', kind: 'file' },
    { name: 'lib', kind: 'directory' },
  ],
  'src/lib': [{ name: 'util.js', kind: 'file' }],
};

test('rankCandidates orders exact, prefix, substring, path substring, subsequence', () => {
  const candidates = [
    { path: 'src/main.c', kind: 'file' },
    { path: 'src/domain.md', kind: 'file' },
    { path: 'main/file.txt', kind: 'file' },
    { path: 'main', kind: 'directory' },
    { path: 'm_a_i_n.txt', kind: 'file' },
    { path: 'zzz.txt', kind: 'file' },
  ];
  const ranked = rankCandidates(candidates, 'main', 6).map((candidate) => candidate.path);
  assert.deepEqual(ranked, ['main', 'src/main.c', 'src/domain.md', 'main/file.txt', 'm_a_i_n.txt']);
  assert.equal(rankCandidates(candidates, 'no-such-name', 6).length, 0);
});

test('a bare query lists the top level and hides dotfiles and excluded directories', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir });
  const candidates = await index.list('', undefined);
  assert.deepEqual(candidates.map((candidate) => candidate.path), ['src', 'README.md']);
});

test('a directory query lists one level; an explicit dot query sees hidden files', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir });
  const candidates = await index.list('src/', undefined);
  assert.deepEqual(candidates.map((candidate) => candidate.path), ['src/lib', 'src/app.js', 'src/main.c']);
  assert.deepEqual(tree.calls, ['src']);
  const hidden = await index.list('.', undefined);
  assert.ok(hidden.some((candidate) => candidate.path === '.env'));
});

test('unsafe directories are refused before any listing', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir });
  assert.deepEqual(await index.list('../etc/', undefined), []);
  assert.deepEqual(await index.list('/etc/', undefined), []);
  assert.deepEqual(await index.list('node_modules/', undefined), []);
  assert.deepEqual(tree.calls, []);
  assert.equal(isSafeRelativeDir('a/b'), true);
  assert.equal(isSafeRelativeDir('a/../b'), false);
  assert.equal(isSafeRelativeDir('/abs'), false);
});

test('a bare query is bounded by the entry budget and reports truncation', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir, maxEntries: 2 });
  await index.list('js', undefined);
  assert.equal(index.truncated, true);
});

test('the directory budget stops a traversal', async () => {
  const wide = { '': [] };
  for (let entry = 0; entry < 5; entry += 1) {
    wide[''].push({ name: `d${entry}`, kind: 'directory' });
    wide[`d${entry}`] = [];
  }
  const tree = makeTree(wide);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir, maxDirs: 2 });
  await index.list('d', undefined);
  assert.equal(index.truncated, true);
  assert.equal(tree.calls.length, 2);
});

test('a settled index answers without a walk until it is invalidated or the TTL expires', async () => {
  let clock = 0;
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir, now: () => clock, cacheTtlMs: 1000 });
  const first = await index.list('app', undefined);
  assert.equal(first[0].path, 'src/app.js');
  assert.deepEqual(tree.calls, ['', 'src', 'src/lib'], 'the first bare query waits for the walk');

  clock = 10;
  await index.list('app', undefined);
  assert.deepEqual(tree.calls, ['', 'src', 'src/lib'], 'a fresh index answers from memory');

  clock = 5000;
  const before = tree.calls.length;
  const stale = await index.list('app', undefined);
  assert.equal(stale[0].path, 'src/app.js', 'the stale index answers the current query');
  await drain();
  assert.ok(tree.calls.length > before, 'the replacement walk runs behind the caret');
});

test('invalidate() forces a rebuild on the next bare query', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir });
  await index.list('app', undefined);
  const walked = tree.calls.length;
  index.invalidate();
  const stale = await index.list('app', undefined);
  assert.equal(stale[0].path, 'src/app.js', 'the settled entries answer first');
  await drain();
  assert.ok(tree.calls.length > walked, 'the invalidated index was rebuilt');
});

test('concurrent bare queries share one traversal', async () => {
  const tree = makeTree(SAMPLE);
  const index = new RemoteWorkspaceIndex({ listDir: tree.listDir });
  const [first, second] = await Promise.all([index.list('a', undefined), index.list('m', undefined)]);
  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.equal(tree.calls.filter((entry) => entry === '').length, 1);
});

test('a failed root listing makes the provider return null and open the cooldown', async () => {
  let clock = 0;
  const provider = createRemoteFileReference({
    listDir: async () => { throw new Error('host unreachable'); },
    config: { failureCooldownMs: 100 },
    now: () => clock,
  });
  assert.equal(await provider.list('', undefined), null);
  // The overlay owns the decision to cool down; the provider only reports the
  // failure as `null` and exposes the window.
  assert.equal(provider.ready(), true, 'a failed listing alone does not open the cooldown');
  provider.markDown();
  assert.equal(provider.ready(), false, 'the cooldown is open');
  clock = 101;
  assert.equal(provider.ready(), true, 'and it closes on its own');
});

test('an aborted query rejects and does not open the cooldown', async () => {
  const tree = makeTree(SAMPLE);
  const provider = createRemoteFileReference({ listDir: tree.listDir });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.list('a', controller.signal), (error) => error.name === 'AbortError');
  assert.equal(provider.ready(), true, 'a cancelled keystroke is not a host failure');
});

test('the overlay answers anchor agents from the remote provider and delegates everyone else', async () => {
  const service = {
    list(agent) {
      return Promise.resolve(agent.remote ? [{ path: 'remote.txt' }] : [{ path: 'local.txt' }]);
    },
  };
  const original = service.list;
  let failed = 0;
  const provider = {
    ready: () => true,
    markDown: () => { failed += 1; },
    async list() { return [{ path: 'from-remote.txt', kind: 'file' }]; },
  };
  const ctx = fakeContext(service);
  const overlay = installFileReferenceOverlay(ctx, {
    resolve: (agent) => (agent.remote ? provider : undefined),
  });
  assert.ok(overlay, 'the overlay installs when the seam exists');

  assert.deepEqual(await service.list({ remote: false }, ''), [{ path: 'local.txt' }]);
  assert.deepEqual(await service.list({ remote: true }, ''), [{ path: 'from-remote.txt', kind: 'file' }]);
  assert.equal(failed, 0);
  overlay.dispose();
  assert.equal(service.list, original, 'dispose restores the original implementation');
});

test('the overlay falls back and opens the cooldown when a listing fails', async () => {
  const service = { list: () => Promise.resolve([{ path: 'local.txt' }]) };
  let failed = 0;
  let listed = 0;
  const provider = {
    ready: () => true,
    markDown: () => { failed += 1; },
    async list() { listed += 1; return null; },
  };
  const ctx = fakeContext(service);
  const overlay = installFileReferenceOverlay(ctx, { resolve: () => provider });
  assert.deepEqual(await service.list({ remote: true }, ''), [{ path: 'local.txt' }]);
  assert.equal(failed, 1);
  assert.equal(listed, 1);
  overlay.dispose();
});

test('the overlay short-circuits a provider that is cooling down', async () => {
  const service = { list: () => Promise.resolve([{ path: 'local.txt' }]) };
  let listed = 0;
  const provider = {
    ready: () => false,
    markDown() {},
    async list() { listed += 1; return []; },
  };
  const overlay = installFileReferenceOverlay(fakeContext(service), { resolve: () => provider });
  assert.deepEqual(await service.list({ remote: true }, ''), [{ path: 'local.txt' }]);
  assert.equal(listed, 0, 'a cooling-down host is not asked again');
  overlay.dispose();
});

test('the overlay tolerates a host without the file-reference service', () => {
  assert.equal(installFileReferenceOverlay({}, { resolve: () => undefined }), undefined);
  assert.equal(installFileReferenceOverlay(undefined, { resolve: () => undefined }), undefined);
  const throwing = { inject() { throw new Error('no seam'); } };
  assert.equal(installFileReferenceOverlay(throwing, { resolve: () => undefined }), undefined);
});

test('the default exclusion list hides the noise the rest of the plugin hides', () => {
  assert.ok(DEFAULT_EXCLUDED_DIRECTORIES.includes('node_modules'));
  assert.ok(DEFAULT_EXCLUDED_DIRECTORIES.includes('.git'));
  assert.ok(DEFAULT_EXCLUDED_DIRECTORIES.includes('.dsh'));
});

/**
 * Minimal cordis-shaped context: `inject` hands the callback the live service
 * object, so the overlay patches the same object the test calls.
 */
function fakeContext(service) {
  const ctx = {
    service,
    effectDisposers: [],
    inject(services, callback) {
      assert.deepEqual(services, ['fileReferences']);
      callback({
        fileReferences: service,
        effect(effect) { ctx.effectDisposers.push(effect()); return () => {}; },
      });
      return { dispose() { for (const dispose of ctx.effectDisposers) dispose(); } };
    },
  };
  return ctx;
}
