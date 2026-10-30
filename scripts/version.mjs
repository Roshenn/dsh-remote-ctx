/**
 * Derive the next version from Conventional Commits and write it everywhere.
 *
 * The repo has no release tooling on purpose, so this script is the whole
 * release pipeline: it reads the commits since the last tag (or, before the
 * first tag, since the commit that first shipped `package.json`), maps their
 * types onto a semver bump, then updates `package.json`, seals the changelog's
 * `## [Unreleased]` section and moves the install pins in the READMEs.
 *
 * Usage:
 *   node scripts/version.mjs --dry-run          # print the plan, write nothing
 *   node scripts/version.mjs                    # apply it
 *   node scripts/version.mjs --bump=minor       # override the derived bump
 *   node scripts/version.mjs --date=2026-01-31  # override the changelog date
 *
 * A release is: run this, review `git diff`, commit `chore(release): X.Y.Z`,
 * then `git tag vX.Y.Z` on that commit. Nothing here tags or pushes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const override = valueOf('--bump');
const date = valueOf('--date') ?? new Date().toISOString().slice(0, 10);

const DOCS = ['README.md', 'README.zh-CN.md', 'INSTALL.md'];
const LEVELS = ['none', 'patch', 'minor', 'major'];

function valueOf(flag) {
  return argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function baseline() {
  try {
    const tag = git('describe', '--tags', '--abbrev=0').trim();
    if (tag) return { ref: tag, label: `tag ${tag}` };
  } catch {
    // no tags yet
  }
  const first = git('log', '--format=%H', '--reverse', '--', 'package.json').trim().split('\n')[0];
  if (!first) throw new Error('cannot find a baseline commit for package.json');
  return { ref: first, label: `commit ${first.slice(0, 7)} (no tag yet)` };
}

function commitsSince(ref) {
  const raw = git('log', '--format=%B%x1e', `${ref}..HEAD`);
  return raw
    .split('\x1e')
    .map((message) => message.trim())
    .filter(Boolean)
    .map(classify)
    .reverse();
}

/** Conventional Commits type -> bump level, before the pre-1.0 mapping. */
function classify(message) {
  const subject = message.split('\n')[0].trim();
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<text>.+)$/.exec(subject);
  if (!match) return { subject, type: 'other', level: 'none', breaking: false };
  const breaking = Boolean(match.groups.bang) || /^BREAKING[ -]CHANGE:/m.test(message);
  const type = match.groups.type;
  let level = 'none';
  if (type === 'feat') level = 'minor';
  else if (type === 'fix' || type === 'perf' || type === 'refactor') level = 'patch';
  if (breaking) level = 'major';
  return { subject, type, level, breaking };
}

function highest(levels) {
  return levels.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), 'none');
}

/**
 * Semver under 1.0: a breaking change is allowed to land in a minor bump, so
 * `major` collapses into `minor` while the version is still 0.x.
 */
function effectiveLevel(level, current) {
  if (Number(current.split('.')[0]) !== 0) return level;
  return level === 'major' ? 'minor' : level;
}

function nextVersion(current, level) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Insert a `## [X.Y.Z] — date` heading below `## [Unreleased]`, sealing it. */
function sealChangelog(text, version) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => /^## \[Unreleased\]/.test(line));
  if (index === -1) return { text, changed: false, reason: 'no `## [Unreleased]` heading' };
  const end = lines.findIndex((line, cursor) => cursor > index && /^## \[/.test(line));
  const section = lines.slice(index + 1, end === -1 ? lines.length : end);
  if (!section.some((line) => /^###\s/.test(line))) {
    return { text, changed: false, reason: '`## [Unreleased]` has no entries to seal' };
  }
  lines.splice(index + 1, 0, '', `## [${version}] — ${date}`);
  return { text: lines.join('\n'), changed: true };
}

function updateDocs(from, to) {
  const changed = [];
  const pin = new RegExp(`^(\`${from.replaceAll('.', '\\.')}\`)`, 'gm');
  for (const file of DOCS) {
    const text = readFileSync(join(root, file), 'utf8');
    const next = text
      .replaceAll(`dsh-remote-ctx@${from}`, `dsh-remote-ctx@${to}`)
      .replace(pin, `\`${to}\``);
    if (next !== text) changed.push(file);
    if (!dryRun) writeFileSync(join(root, file), next);
  }
  return changed;
}

function main() {
  const pkgPath = join(root, 'package.json');
  const pkgText = readFileSync(pkgPath, 'utf8');
  const current = /"version":\s*"([^"]+)"/.exec(pkgText)?.[1];
  if (!current) throw new Error('package.json has no version field');

  const base = baseline();
  const commits = commitsSince(base.ref);
  const derived = override ? effectiveLevel(normalizeOverride(override), current) : effectiveLevel(highest(commits.map((c) => c.level)), current);

  console.log(`dsh-remote-ctx release plan`);
  console.log(`  current:   ${current}`);
  console.log(`  baseline:  ${base.label}`);
  console.log(`  commits:   ${commits.length} since the baseline`);

  const counts = new Map();
  for (const commit of commits) counts.set(commit.level, (counts.get(commit.level) ?? 0) + 1);
  console.log(`  signals:   ${[...counts].map(([level, count]) => `${count} ${level}`).join(', ') || 'none'}`);
  for (const commit of commits.filter((c) => c.level !== 'none')) {
    console.log(`    ${commit.level.padEnd(5)} ${commit.subject}`);
  }

  if (derived === 'none') {
    console.log(`  result:    nothing to release (only docs/style/test/chore commits)`);
    console.log(`             pass --bump=patch|minor|major to force one`);
    return;
  }

  const next = nextVersion(current, derived);
  console.log(`  result:    ${current} -> ${next} (${derived})`);

  const changelogPath = join(root, 'CHANGELOG.md');
  const sealed = sealChangelog(readFileSync(changelogPath, 'utf8'), next);
  console.log(`  changelog: ${sealed.changed ? `seal Unreleased as ${next}` : `skipped — ${sealed.reason}`}`);
  const docs = updateDocs(current, next);
  console.log(`  pins:      ${docs.length ? docs.join(', ') : 'no `@' + current + '` pins found'}`);
  console.log(`  package:   version ${dryRun ? 'would become' : 'becomes'} ${next}`);

  if (dryRun) {
    console.log(`\ndry run — nothing written. Re-run without --dry-run to apply.`);
    return;
  }

  writeFileSync(pkgPath, pkgText.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
  if (sealed.changed) writeFileSync(changelogPath, sealed.text);

  console.log(`\nnext steps:`);
  console.log(`  git add package.json CHANGELOG.md ${docs.join(' ') || ''}`.trimEnd());
  console.log(`  git commit -m "chore(release): ${next}"`);
  console.log(`  git tag -a v${next} -m "v${next}"`);
}

function normalizeOverride(value) {
  if (!LEVELS.includes(value) || value === 'none') {
    throw new Error(`--bump must be patch, minor or major (got "${value}")`);
  }
  return value;
}

main();
