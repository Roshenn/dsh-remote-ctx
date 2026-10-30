/**
 * The dev-link helper: the two manifest edits that install this checkout into a
 * profile the way `dsh-looptree-dashboard` is installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkSpec, main, unwireProfile, wireProfile } from '../scripts/dev-link.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-devlink-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

function makeProfile(name = 'profile') {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-unlag': '1.14.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-unlag'] } },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, file: join(dir, 'package.json') };
}

test('linkSpec produces a relative link: reference with forward slashes', () => {
  // Native separators on purpose: on Windows `relative()` returns backslashes,
  // and producing the forward-slash `link:` spelling is exactly what this
  // asserts. Hardcoding `C:\` here used to make the case pass on Windows only.
  const profileDir = join(tmpdir(), 'dsh', 'profiles', 'desktop');
  const packageDir = join(tmpdir(), 'dsh', 'dsh-remote-ctx');
  const spec = linkSpec(profileDir, packageDir);
  assert.equal(spec, 'link:../../dsh-remote-ctx');
});

test('wireProfile adds the dependency and the bundle entry', () => {
  const manifest = { dependencies: { 'dsh-unlag': '1.14.2' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  const wired = wireProfile(manifest, 'link:../../dsh-remote-ctx');
  assert.equal(wired.dependencies['dsh-remote-ctx'], 'link:../../dsh-remote-ctx');
  assert.deepEqual(wired.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-remote-ctx']);
  // The input is not mutated, so a dry run can print and discard safely.
  assert.equal(manifest.dependencies['dsh-remote-ctx'], undefined);
});

test('wireProfile is idempotent', () => {
  const once = wireProfile({ dsh: { profile: { bundles: [] } } }, 'link:../../dsh-remote-ctx');
  const twice = wireProfile(once, 'link:../../dsh-remote-ctx');
  assert.equal(twice.dsh.profile.bundles.filter((entry) => entry === 'dsh-remote-ctx').length, 1);
  assert.deepEqual(twice, once);
});

test('unwireProfile removes both edits', () => {
  const wired = wireProfile({ dependencies: {}, dsh: { profile: { bundles: ['base'] } } }, 'link:../../dsh-remote-ctx');
  const unwired = unwireProfile(wired);
  assert.equal(unwired.dependencies['dsh-remote-ctx'], undefined);
  assert.deepEqual(unwired.dsh.profile.bundles, ['base']);
});

test('main() wires a profile on disk', () => {
  const profile = makeProfile('wire');
  assert.equal(main(['--profile', profile.dir]), 0);
  const saved = JSON.parse(readFileSync(profile.file, 'utf8'));
  assert.match(saved.dependencies['dsh-remote-ctx'], /^link:/);
  assert.ok(saved.dsh.profile.bundles.includes('dsh-remote-ctx'));
});

test('main() --dry-run prints but does not write', () => {
  const profile = makeProfile('dry');
  const before = readFileSync(profile.file, 'utf8');
  assert.equal(main(['--profile', profile.dir, '--dry-run']), 0);
  assert.equal(readFileSync(profile.file, 'utf8'), before);
});

test('main() --remove restores the manifest', () => {
  const profile = makeProfile('remove');
  main(['--profile', profile.dir]);
  assert.equal(main(['--profile', profile.dir, '--remove']), 0);
  const saved = JSON.parse(readFileSync(profile.file, 'utf8'));
  assert.equal(saved.dependencies['dsh-remote-ctx'], undefined);
  assert.ok(!saved.dsh.profile.bundles.includes('dsh-remote-ctx'));
});

test('main() fails cleanly on a missing profile directory', () => {
  const missing = join(workspace, 'nope');
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(main(['--profile', missing]), 1);
  } finally {
    console.error = originalError;
  }
});
