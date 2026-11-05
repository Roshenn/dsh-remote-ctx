/**
 * Pure POSIX path handling for the remote side.
 *
 * Every remote path this plugin touches goes through here: a model-supplied or
 * browser-supplied path is normalised, then proven to sit inside the
 * connection's `remoteRoot`. Nothing here imports `ssh2` or touches the disk,
 * so the rules can be tested with plain strings.
 */
import { posix } from 'node:path';

export class RemotePathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemotePathError';
    this.code = code;
  }
}

/** `~` and `~/x` expand against the remote login home; everything else is left alone. */
export function expandHome(value, home) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return posix.join(home, value.slice(2));
  return value;
}

/**
 * Normalise a remote path to a clean absolute POSIX path.
 *
 * A relative path is an error rather than "relative to cwd": the remote cwd of
 * an SFTP session is not a contract anyone should rely on, and a silent
 * `./foo` resolving somewhere unexpected on the target is exactly the class of
 * bug this plugin exists to avoid.
 */
export function normalizeRemotePath(value, options = {}) {
  const home = options.home ?? '/';
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RemotePathError('REMOTE_PATH_INVALID', 'remote path is required');
  }
  const expanded = expandHome(value.trim(), home);
  // A `~` root is stored unresolved so moving a checkout to another user does
  // not silently pin the old home directory. It is expanded at connect time.
  if (expanded === '~' || expanded.startsWith('~/')) {
    const kept = posix.normalize(expanded);
    return kept.length > 1 ? kept.replace(/\/+$/, '') : kept;
  }
  if (!expanded.startsWith('/')) {
    throw new RemotePathError(
      'REMOTE_PATH_INVALID',
      `remote path must be absolute or start with ~: ${value}`,
    );
  }
  const normalized = posix.normalize(expanded);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}

/** True when `target` is `root` itself or sits below it. */
export function isInsideRoot(root, target) {
  if (root === target) return true;
  if (root === '/') return target.startsWith('/');
  return target.startsWith(`${root}/`);
}

/**
 * Resolve `requested` against `root` and refuse anything that escapes it.
 *
 * This is the single gate between an untrusted path (model argument, HTTP body)
 * and an SFTP operation, so it must stay the only way a remote path is built.
 */
export function resolveWithinRoot(root, requested, options = {}) {
  const home = options.home ?? '/';
  const cleanRoot = normalizeRemotePath(root, { home });
  if (requested === undefined || requested === null || String(requested).trim() === '') return cleanRoot;
  const expanded = expandHome(String(requested).trim(), home);
  const candidate = expanded.startsWith('/')
    ? posix.normalize(expanded)
    : posix.normalize(posix.join(cleanRoot, expanded));
  if (!isInsideRoot(cleanRoot, candidate)) {
    throw new RemotePathError(
      'REMOTE_PATH_OUTSIDE_ROOT',
      `remote path ${requested} escapes the connection root ${cleanRoot}`,
    );
  }
  return candidate;
}

/** Path of `target` relative to `root`, POSIX-style; `.` for the root itself. */
export function relativeToRoot(root, target) {
  const rel = posix.relative(normalizeRemotePath(root), normalizeRemotePath(target));
  return rel === '' ? '.' : rel;
}

/**
 * Resolve `requested` against one directory inside `root`.
 *
 * A remote workspace is a subdirectory of the connection root, and the model
 * speaks in workspace-relative paths (`src/main.c`, the spelling `@` completion
 * offers). Absolute and `~`-prefixed paths keep the connection-root semantics
 * they had before: only a relative path moves against `base`.
 *
 * @param {string} root connection root (the confinement boundary)
 * @param {string} base workspace directory, itself inside `root`
 * @param {string} requested untrusted path from a tool argument
 * @param {object} [options] `{ home }` for `~` expansion
 */
export function resolveFromBase(root, base, requested, options = {}) {
  const cleanRoot = normalizeRemotePath(root, options);
  const cleanBase = resolveWithinRoot(cleanRoot, base, options);
  const text = requested === undefined || requested === null ? '' : String(requested).trim();
  if (text === '') return cleanBase;
  const absolute = expandHome(text, options.home ?? '/').startsWith('/');
  const target = resolveWithinRoot(absolute ? cleanRoot : cleanBase, text, options);
  // `cleanBase` is inside `cleanRoot`, so a relative join cannot escape; this
  // assertion is the belt to `resolveWithinRoot`'s braces for the absolute case.
  if (!isInsideRoot(cleanRoot, target)) {
    throw new RemotePathError('REMOTE_PATH_OUTSIDE_ROOT', `remote path ${requested} escapes the connection root ${cleanRoot}`);
  }
  return target;
}

/** Join a root-relative path back onto a remote root. */
export function joinRemote(root, relative) {
  const cleanRoot = normalizeRemotePath(root);
  if (relative === '.' || relative === '') return cleanRoot;
  return posix.normalize(posix.join(cleanRoot, relative));
}

/**
 * Deterministic code-unit ordering for paths and names.
 *
 * `localeCompare` would make listing order depend on the host's collation
 * (case, accents, ICU version), which turns a stable index into a diffing one.
 */
export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A stable, filesystem-safe id derived from a label (falls back to host). */export function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'remote';
}
