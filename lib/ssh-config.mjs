/**
 * `~/.ssh/config` reader.
 *
 * The point of this module is that a person with a working SSH setup should not
 * retype it into a panel: every `Host` block already answers "which machine,
 * which user, which port, which key". This reads those answers without spawning
 * `ssh -G` (the plugin never executes commands) and without touching the
 * network.
 *
 * Scope, deliberately:
 *   - `Host` blocks, `Include`, and the five keywords a connection needs
 *     (HostName, User, Port, IdentityFile, ProxyJump/ProxyCommand);
 *   - OpenSSH's first-obtained-value-wins rule across blocks in file order;
 *   - `*` / `?` wildcards and `!` negation in `Host` patterns;
 *   - `Match` blocks are skipped — they depend on runtime state this parser
 *     does not have, and guessing them is worse than ignoring them.
 *
 * Everything here is pure except `loadSshConfig`, which reads local files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolveLocal } from 'node:path';
import { compareText } from './paths.mjs';

/** The keywords that become a connection record, plus the two that block one. */
const KNOWN = new Set([
  'hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand',
]);

/** OpenSSH's default identity files, in the order `ssh` tries them. */
export const DEFAULT_IDENTITY_FILES = Object.freeze(['id_ed25519', 'id_ecdsa', 'id_rsa']);

const WILDCARD = /[*?]/;

/**
 * Split a config line into tokens, honouring quotes and stripping a trailing
 * comment. Quoted text stays inside its token, so `Host "two words"` is one
 * pattern with a space — which is how OpenSSH reads it.
 */
export function tokenize(line) {
  const tokens = [];
  let token = '';
  let quote = null;
  let inToken = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      inToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    // A '#' starts a comment at a token boundary; inside a value it is literal.
    if (char === '#' && !inToken) break;
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(token);
        token = '';
        inToken = false;
      }
      continue;
    }
    token += char;
    inToken = true;
  }
  if (inToken) tokens.push(token);
  return tokens;
}

/** `*` and `?` only, anchored — this is host-pattern matching, not a regex dialect. */
export function hostPatternMatches(pattern, alias) {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i').test(alias);
}

/** True when the block's patterns select `alias` (positive hit, no negation). */
export function blockMatches(patterns, alias) {
  let positive = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (hostPatternMatches(pattern.slice(1), alias)) return false;
    } else if (hostPatternMatches(pattern, alias)) {
      positive = true;
    }
  }
  return positive;
}

/**
 * Parse one config document into ordered items: `{ kind: 'block' }` and
 * `{ kind: 'include' }`, so `loadSshConfig` can splice includes at the right
 * position (OpenSSH applies included content inline).
 */
export function parseSshConfig(text, source = 'config') {
  const items = [];
  let current = null;
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const keyword = tokens[0].toLowerCase();
    if (keyword === 'host') {
      // `Host a b` is the documented form; accept `Host a, b` too because it is common in hand-written configs.
      current = { source, patterns: tokens.slice(1).flatMap((token) => token.split(',')).filter(Boolean), options: {} };
      items.push({ kind: 'block', block: current });
      continue;
    }
    if (keyword === 'match') {
      // A Match block's options are conditional on runtime state; skip the block.
      current = null;
      continue;
    }
    if (keyword === 'include') {
      items.push({ kind: 'include', value: tokens.slice(1).join(' '), source });
      continue;
    }
    if (!current || !KNOWN.has(keyword)) continue;
    // First obtained value wins within a block, same as OpenSSH.
    if (!(keyword in current.options)) current.options[keyword] = tokens.slice(1).join(' ');
  }
  return items;
}

function expandTilde(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

function includeTargets(value, { home, dir }) {
  const targets = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    if (WILDCARD.test(token)) continue; // glob includes are reported, not guessed
    const expanded = expandTilde(token, home);
    targets.push(expanded.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(expanded)
      ? resolveLocal(expanded)
      : resolveLocal(dir, expanded));
  }
  return targets;
}

/**
 * Read a config file and everything it includes, in file order.
 * Resolves to `{ path, files, blocks, unresolvedIncludes, missing }`.
 */
export function loadSshConfig(file, options = {}) {
  const home = options.home ?? homedir();
  const maxDepth = options.maxDepth ?? 3;
  const readFile = options.readFile ?? ((target) => readFileSync(target, 'utf8'));
  const exists = options.exists ?? ((target) => existsSync(target));
  const start = resolveLocal(expandTilde(file, home));
  const files = [];
  const blocks = [];
  const unresolvedIncludes = [];

  const walk = (target, depth) => {
    if (depth > maxDepth || !exists(target)) return;
    files.push(target);
    for (const item of parseSshConfig(readFile(target), target)) {
      if (item.kind === 'block') {
        blocks.push(item.block);
        continue;
      }
      const targets = includeTargets(item.value, { home, dir: dirname(target) });
      if (targets.length === 0) unresolvedIncludes.push(item.value);
      for (const includeTarget of targets) walk(includeTarget, depth + 1);
    }
  };

  walk(start, 0);
  return { path: start, files, blocks, unresolvedIncludes, missing: !exists(start) };
}

/** The first default identity file that actually exists, if any. */
export function defaultIdentityFile(home, exists = (target) => existsSync(target)) {
  for (const name of DEFAULT_IDENTITY_FILES) {
    const candidate = join(home, '.ssh', name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** The block items of a parse result, in file order. */
export function blocksOf(items) {
  return items.filter((item) => item.kind === 'block').map((item) => item.block);
}

/**
 * Turn Host blocks into one effective record per concrete alias.
 *
 * A pattern containing `*` or `?` is a rule, not a machine, so it is not listed
 * — but rules still contribute their options to every alias they match, which
 * is exactly how `Host *` defaults work.
 */
export function discoverHosts(blocks, options = {}) {
  const home = options.home ?? homedir();
  const defaultKey = options.defaultIdentityFile !== undefined
    ? options.defaultIdentityFile
    : defaultIdentityFile(home);

  const aliases = [];
  const seen = new Set();
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (pattern.startsWith('!') || WILDCARD.test(pattern)) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      aliases.push(pattern);
    }
  }

  const entries = aliases.map((alias) => {
    const effective = {};
    for (const block of blocks) {
      if (!blockMatches(block.patterns, alias)) continue;
      for (const [key, value] of Object.entries(block.options)) {
        if (!(key in effective)) effective[key] = value;
      }
    }
    const identityFile = effective.identityfile
      ? resolveLocal(expandTilde(effective.identityfile, home))
      : (defaultKey ? resolveLocal(expandTilde(defaultKey, home)) : undefined);
    const port = Number(effective.port ?? 22);
    return {
      alias,
      hostName: effective.hostname ?? alias,
      user: effective.user,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      identityFile,
      proxyJump: effective.proxyjump,
      proxyCommand: effective.proxycommand,
      source: blocks.find((block) => block.patterns.includes(alias))?.source,
    };
  });

  entries.sort((left, right) => compareText(left.alias, right.alias));
  return entries;
}

/** One call for the context: read the file (if any) and list connectable hosts. */
export function readDiscoveredHosts(file, options = {}) {
  const config = loadSshConfig(file, options);
  return {
    path: config.path,
    files: config.files,
    missing: config.missing,
    unresolvedIncludes: config.unresolvedIncludes,
    entries: config.missing ? [] : discoverHosts(config.blocks, options),
  };
}
