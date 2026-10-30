/**
 * Remote path rules: this is the security boundary between an untrusted path
 * (a model argument, an HTTP body) and an SFTP call, so it is tested hardest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemotePathError,
  expandHome,
  isInsideRoot,
  joinRemote,
  normalizeRemotePath,
  relativeToRoot,
  resolveWithinRoot,
  slugify,
} from '../lib/paths.mjs';

test('expandHome resolves the tilde forms only', () => {
  assert.equal(expandHome('~', '/home/j'), '/home/j');
  assert.equal(expandHome('~/work', '/home/j'), '/home/j/work');
  assert.equal(expandHome('/abs/~/x', '/home/j'), '/abs/~/x');
  assert.equal(expandHome('relative', '/home/j'), 'relative');
});

test('normalizeRemotePath cleans absolute paths and keeps a ~ root unresolved', () => {
  assert.equal(normalizeRemotePath('/srv//work/'), '/srv/work');
  assert.equal(normalizeRemotePath('/srv/./work/../work'), '/srv/work');
  assert.equal(normalizeRemotePath('/'), '/');
  assert.equal(normalizeRemotePath('~', { home: '~' }), '~');
  assert.equal(normalizeRemotePath('~/work/', { home: '~' }), '~/work');
  assert.equal(normalizeRemotePath('~/work', { home: '/home/j' }), '/home/j/work');
});

test('normalizeRemotePath refuses relative and empty paths', () => {
  assert.throws(() => normalizeRemotePath('src/index.js'), RemotePathError);
  assert.throws(() => normalizeRemotePath('   '), RemotePathError);
  assert.throws(() => normalizeRemotePath(undefined), RemotePathError);
});

test('isInsideRoot is prefix-safe at the separator', () => {
  assert.ok(isInsideRoot('/srv/work', '/srv/work'));
  assert.ok(isInsideRoot('/srv/work', '/srv/work/src'));
  assert.ok(!isInsideRoot('/srv/work', '/srv/work-other'));
  assert.ok(isInsideRoot('/', '/anything'));
});

test('resolveWithinRoot defaults to the root and resolves relatives under it', () => {
  assert.equal(resolveWithinRoot('/srv/work', undefined), '/srv/work');
  assert.equal(resolveWithinRoot('/srv/work', ''), '/srv/work');
  assert.equal(resolveWithinRoot('/srv/work', 'src/a.js'), '/srv/work/src/a.js');
  assert.equal(resolveWithinRoot('/srv/work', '/srv/work/src'), '/srv/work/src');
  assert.equal(resolveWithinRoot('/srv/work', '/srv/work/../work/x'), '/srv/work/x');
});

test('resolveWithinRoot refuses every escape', () => {
  assert.throws(() => resolveWithinRoot('/srv/work', '/srv/work/../secret'), RemotePathError);
  assert.throws(() => resolveWithinRoot('/srv/work', '/etc/passwd'), RemotePathError);
  assert.throws(() => resolveWithinRoot('/srv/work', '../../etc'), RemotePathError);
  assert.throws(() => resolveWithinRoot('/srv/work', '/srv/work-other/x'), RemotePathError);
});

test('resolveWithinRoot expands a ~ root against the remote home', () => {
  assert.equal(resolveWithinRoot('~/work', 'src/a.js', { home: '/home/j' }), '/home/j/work/src/a.js');
  assert.throws(() => resolveWithinRoot('~/work', '/home/j', { home: '/home/j' }), RemotePathError);
});

test('relativeToRoot and joinRemote round-trip', () => {
  assert.equal(relativeToRoot('/srv/work', '/srv/work/src/a.js'), 'src/a.js');
  assert.equal(relativeToRoot('/srv/work', '/srv/work'), '.');
  assert.equal(joinRemote('/srv/work', 'src/a.js'), '/srv/work/src/a.js');
  assert.equal(joinRemote('/srv/work', '.'), '/srv/work');
});

test('slugify produces filesystem-safe ids', () => {
  assert.equal(slugify('Lecoo LAN'), 'lecoo-lan');
  assert.equal(slugify('  '), 'remote');
  assert.equal(slugify('prod_eu-1'), 'prod-eu-1');
});
