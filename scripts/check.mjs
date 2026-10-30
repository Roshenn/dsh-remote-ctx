/**
 * Package sanity check.
 *
 * Verifies the parts a dsh install actually reads: the `dsh` manifest, the
 * bundle patch file it points at, the two exports, and the shipped file list.
 * Also fails if the browser bundle ever learns what a password is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(manifest.name === 'dsh-remote-ctx', `package name is ${manifest.name}`);
check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), 'version must be semver');
check(manifest.license === 'MIT', 'license must be MIT');
check(manifest.type === 'module', 'package must be ESM (type: module)');
check(manifest.dsh?.manifestVersion === 1, 'dsh.manifestVersion must be 1');
check(typeof manifest.dsh?.bundle?.patch === 'string', 'dsh.bundle.patch is required');

const patch = manifest.dsh?.bundle?.patch;
if (patch) {
  const patchPath = join(root, patch);
  check(existsSync(patchPath), `bundle patch ${patch} does not exist`);
  if (existsSync(patchPath)) {
    const yaml = readFileSync(patchPath, 'utf8');
    check(yaml.includes("name: 'dsh-remote-ctx'"), 'bundle patch must mount the plugin row named dsh-remote-ctx');
    check(yaml.includes('id: remote-ctx'), 'bundle patch row id must be remote-ctx');
  }
}

for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key === './package.json') continue;
  check(existsSync(join(root, target)), `exports["${key}"] -> ${target} does not exist`);
}
check(manifest.files?.includes('cordis.patch.yml'), 'files[] must ship cordis.patch.yml');
check(manifest.files?.includes('lib'), 'files[] must ship lib/');
check(existsSync(join(root, 'LICENSE')), 'LICENSE is missing');
check(readFileSync(join(root, 'LICENSE'), 'utf8').includes('MIT License'), 'LICENSE is not the MIT text');
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must be web for the sidebar panel');
check(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject must be a static array');
check(manifest.engines?.dsh, 'engines.dsh must be declared (installers surface it)');
check(Boolean(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']), 'peerDependencies must declare @deepseek-ai/dsh-tools');

const client = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(!/auth\s*\.\s*password/.test(client), 'the browser half must never read a stored password');
check(!/require\(['"]ssh2['"]\)/.test(client), 'the browser half must not import ssh2');

if (failures.length) {
  console.error('package check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`package check ok · ${manifest.name}@${manifest.version}`);
