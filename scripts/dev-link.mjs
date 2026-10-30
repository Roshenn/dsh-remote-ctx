/**
 * Wire this checkout into a DSH profile as a linked bundle.
 *
 * This is the same installation shape `dsh-looptree-dashboard` uses in a dev
 * profile: a `link:` dependency plus a `dsh.profile.bundles` entry, followed by
 * `pnpm install` in the profile. It exists because the desktop profile cannot be
 * managed from the `dsh plugin` CLI, and because doing it by hand gets one of
 * the two edits wrong often enough to be worth a script.
 *
 * "A linked checkout keeps its own node_modules" (DSH packaging docs): the
 * profile install never installs this package's dependencies, so `ssh2` must be
 * present in the checkout itself — `npm install --no-package-lock` here.
 *
 * Usage:
 *   node scripts/dev-link.mjs --profile <profile-dir> [--remove] [--dry-run] [--install]
 *   node scripts/dev-link.mjs                       # defaults to $DSH_HOME/profiles/desktop
 *
 * Exit codes: 0 ok, 1 bad usage / missing profile, 2 the profile edit failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-remote-ctx';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultProfilePath(env = process.env) {
  const home = env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), '.dsh');
  return join(home, 'profiles', 'desktop');
}

/** `link:` spec pointing at this checkout, relative to the profile directory. */
export function linkSpec(profileDir, packageDir = repoRoot) {
  const rel = relative(resolve(profileDir), resolve(packageDir)).split('\\').join('/');
  return `link:${rel.startsWith('.') ? rel : `./${rel}`}`;
}

function sortedKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
}

/** Add the dependency and the bundle entry. Pure: returns a new manifest. */
export function wireProfile(manifest, spec, name = PACKAGE) {
  const next = structuredClone(manifest);
  next.dependencies = sortedKeys({ ...(next.dependencies ?? {}), [name]: spec });
  const profile = next.dsh?.profile ?? {};
  const bundles = [...(profile.bundles ?? [])];
  if (!bundles.includes(name)) bundles.push(name);
  next.dsh = { ...(next.dsh ?? {}), profile: { ...profile, bundles } };
  return next;
}

/** Remove both edits again. Pure: returns a new manifest. */
export function unwireProfile(manifest, name = PACKAGE) {
  const next = structuredClone(manifest);
  if (next.dependencies) {
    delete next.dependencies[name];
    next.dependencies = sortedKeys(next.dependencies);
  }
  if (Array.isArray(next.dsh?.profile?.bundles)) {
    next.dsh.profile.bundles = next.dsh.profile.bundles.filter((entry) => entry !== name);
  }
  return next;
}

export function readProfile(profileDir) {
  const file = join(profileDir, 'package.json');
  if (!existsSync(file)) throw new Error(`no package.json in ${profileDir}`);
  return { file, manifest: JSON.parse(readFileSync(file, 'utf8')) };
}

function writeProfile(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = { profile: undefined, remove: false, dryRun: false, install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--remove') options.remove = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function help() {
  return [
    'Wire dsh-remote-ctx into a DSH profile as a linked bundle.',
    '',
    '  node scripts/dev-link.mjs --profile <dir> [--remove] [--dry-run] [--install]',
    '',
    '  --profile <dir>  profile directory (default: $DSH_HOME/profiles/desktop)',
    '  --remove         remove the dependency and the bundle entry again',
    '  --dry-run        print the manifest changes without writing',
    '  --install        run `pnpm install --prefer-offline` in the profile afterwards',
    '',
    'A linked checkout keeps its own node_modules, so run `npm install --no-package-lock`',
    'in this repo before starting DSH.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(help());
    return 1;
  }
  if (options.help) {
    console.log(help());
    return 0;
  }

  const profileDir = resolve(options.profile ?? defaultProfilePath(env));
  if (!existsSync(profileDir)) {
    console.error(`profile directory not found: ${profileDir}`);
    return 1;
  }

  let profile;
  try {
    profile = readProfile(profileDir);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const spec = linkSpec(profileDir);
  const next = options.remove
    ? unwireProfile(profile.manifest)
    : wireProfile(profile.manifest, spec);

  if (options.dryRun) {
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }

  try {
    writeProfile(profile.file, next);
  } catch (error) {
    console.error(`could not write ${profile.file}: ${error.message}`);
    return 2;
  }

  console.log(options.remove
    ? `removed ${PACKAGE} from ${profileDir}`
    : `wired ${PACKAGE} -> ${spec} in ${profileDir}`);

  if (options.remove) return 0;

  if (options.install) {
    const result = spawnSync('pnpm', ['install', '--prefer-offline'], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      console.error('pnpm install failed; fix it before restarting DSH');
      return result.status ?? 1;
    }
  } else {
    console.log(`next: cd "${profileDir}" && pnpm install --prefer-offline`);
  }
  if (!existsSync(join(repoRoot, 'node_modules', 'ssh2'))) {
    console.log(`also: cd "${repoRoot}" && npm install --no-package-lock   (linked checkouts keep their own node_modules)`);
  }
  console.log('then fully quit and relaunch DeepSeek Harness (a page reload does not load plugins)');
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
