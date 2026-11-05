/**
 * Local anchors for remote workspaces: stable names, the marker + AGENTS.md,
 * and idempotency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorContaining, anchorName, anchorPath, createAnchor, isPlaceholder, listAnchors, PLACEHOLDER_PREFIX, prunePlaceholderFiles, readAnchor } from '../lib/workspace.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-workspace-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

const connection = {
  id: 'lan-box',
  label: 'LAN box',
  host: '10.1.64.4',
  port: 22,
  username: 'root',
  remoteRoot: '/srv/work',
  auth: { kind: 'agent' },
};

test('anchor names are stable and path-specific', () => {
  assert.equal(anchorName('lan-box', '/srv/work'), anchorName('lan-box', '/srv/work'));
  assert.notEqual(anchorName('lan-box', '/srv/work'), anchorName('lan-box', '/srv/other'));
  assert.notEqual(anchorName('lan-box', '/srv/work'), anchorName('other', '/srv/work'));
  assert.match(anchorName('lan-box', '/srv/work'), /^lan-box-[0-9a-f]{10}$/);
  assert.equal(anchorPath('/anchors', 'lan-box', '/srv/work'), join('/anchors', anchorName('lan-box', '/srv/work')));
});

test('createAnchor writes the marker and the instructions', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/app' });
  assert.equal(anchor.created, true);
  assert.ok(existsSync(join(anchor.path, 'remote-ctx.json')));
  assert.ok(existsSync(join(anchor.path, 'AGENTS.md')));

  const marker = readAnchor(anchor.path);
  assert.equal(marker.connectionId, 'lan-box');
  assert.equal(marker.remotePath, '/srv/work/app');
  assert.equal(marker.host, '10.1.64.4');

  const instructions = readFileSync(join(anchor.path, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /local anchor/);
  assert.match(instructions, /remote_ctx_ls/);
  assert.match(instructions, /lan-box/);
});

test('createAnchor is idempotent and keeps createdAt', () => {
  const first = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/app' });
  const second = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/app' });
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.equal(second.marker.createdAt, first.marker.createdAt);
});

test('different remote directories get different anchors', () => {
  const one = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/a' });
  const two = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/b' });
  assert.notEqual(one.path, two.path);
});

test('prunePlaceholderFiles removes the old listing and nothing else', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/prune' });
  mkdirSync(join(anchor.path, 'src'), { recursive: true });
  mkdirSync(join(anchor.path, 'emptied'), { recursive: true });
  writeFileSync(join(anchor.path, 'src', 'app.js'), `${PLACEHOLDER_PREFIX} /srv/prune/src/app.js\n`);
  writeFileSync(join(anchor.path, 'src', 'edited.js'), 'user edit\n');
  writeFileSync(join(anchor.path, 'notes.md'), `${PLACEHOLDER_PREFIX} /srv/prune/notes.md\n`);
  writeFileSync(join(anchor.path, 'emptied', 'old.js'), `${PLACEHOLDER_PREFIX} /srv/prune/emptied/old.js\n`);
  assert.equal(isPlaceholder(join(anchor.path, 'notes.md')), true);

  const removed = prunePlaceholderFiles(anchor.path);
  assert.equal(removed, 3);
  assert.equal(existsSync(join(anchor.path, 'src', 'app.js')), false);
  assert.equal(existsSync(join(anchor.path, 'notes.md')), false);
  assert.equal(existsSync(join(anchor.path, 'emptied')), false, 'a directory the listing emptied goes too');
  assert.equal(readFileSync(join(anchor.path, 'src', 'edited.js'), 'utf8'), 'user edit\n', 'a local edit is never discarded');
  assert.ok(existsSync(join(anchor.path, 'AGENTS.md')), 'the anchor own files stay');
  assert.ok(existsSync(join(anchor.path, 'remote-ctx.json')));
  assert.ok(existsSync(join(anchor.path, 'src')), 'a directory that still holds a file stays');
});

test('prunePlaceholderFiles leaves an anchor it did not write untouched', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/clean' });
  mkdirSync(join(anchor.path, 'docs'), { recursive: true });
  writeFileSync(join(anchor.path, 'docs', 'notes.md'), 'user notes\n');
  assert.equal(prunePlaceholderFiles(anchor.path), 0);
  assert.equal(readFileSync(join(anchor.path, 'docs', 'notes.md'), 'utf8'), 'user notes\n');
});

test('listAnchors ignores directories that carry no marker', () => {
  const created = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/listed' });
  mkdirSync(join(workspace, 'not-an-anchor'), { recursive: true });
  const anchors = listAnchors(workspace);
  assert.equal(anchors.some((anchor) => anchor.path === created.path), true);
  assert.equal(anchors.some((anchor) => anchor.path.endsWith('not-an-anchor')), false);
  assert.equal(anchors.find((anchor) => anchor.path === created.path).marker.connectionId, 'lan-box');
});

test('anchorContaining recognises the anchor above a subdirectory, and nothing else', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work/contained' });
  const child = join(anchor.path, 'src', 'deep');
  mkdirSync(child, { recursive: true });

  // The session cwd is normally the anchor itself; a `cd` may leave it below.
  assert.equal(anchorContaining(anchor.path, workspace)?.path, anchor.path);
  assert.equal(anchorContaining(child, workspace)?.path, anchor.path);

  // Local directories, the workspaces root and prefix siblings are not anchors.
  assert.equal(anchorContaining(join(workspace, 'local-checkout'), workspace), undefined);
  assert.equal(anchorContaining(workspace, workspace), undefined);
  assert.equal(anchorContaining(join(workspace, '..'), workspace), undefined);
  assert.equal(anchorContaining(`${anchor.path}-other`, workspace), undefined);
  assert.equal(anchorContaining('', workspace), undefined);
  assert.equal(anchorContaining(anchor.path, ''), undefined);
});
