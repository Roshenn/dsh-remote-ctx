/**
 * Local anchors for remote workspaces: stable names, the marker + AGENTS.md,
 * and idempotency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorName, anchorPath, createAnchor, isPlaceholder, materializeListing, readAnchor } from '../lib/workspace.mjs';

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

test('materializeListing writes directories and placeholder files', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work' });
  const result = materializeListing({
    anchorPath: anchor.path,
    connectionId: 'lan-box',
    remotePrefix: '/srv/work',
    entries: [
      { path: 'src', type: 'dir' },
      { path: 'src/app.js', type: 'file' },
      { path: 'README.md', type: 'file' },
      { path: 'AGENTS.md', type: 'file' },
    ],
  });
  assert.equal(result.files, 2);
  assert.equal(result.dirs, 1);
  // The anchor owns AGENTS.md; a remote file with that name never replaces it.
  assert.equal(result.skipped, 1);

  const placeholder = join(anchor.path, 'src', 'app.js');
  assert.ok(existsSync(placeholder));
  assert.match(readFileSync(placeholder, 'utf8'), /remote file: \/srv\/work\/src\/app\.js/);
  assert.equal(isPlaceholder(placeholder), true);
  assert.match(readFileSync(join(anchor.path, 'AGENTS.md'), 'utf8'), /Remote workspace/);
});

test('materializeListing never clobbers a real local file', () => {
  const anchor = createAnchor({ workspacesDir: workspace, connection, remotePath: '/srv/work' });
  mkdirSync(join(anchor.path, 'docs'), { recursive: true });
  writeFileSync(join(anchor.path, 'docs', 'notes.md'), 'user notes\n');
  const result = materializeListing({
    anchorPath: anchor.path,
    connectionId: 'lan-box',
    remotePrefix: '/srv/work',
    entries: [
      { path: 'docs', type: 'dir' },
      { path: 'docs/notes.md', type: 'file' },
    ],
  });
  assert.equal(result.skipped, 1);
  assert.equal(readFileSync(join(anchor.path, 'docs', 'notes.md'), 'utf8'), 'user notes\n');
});
