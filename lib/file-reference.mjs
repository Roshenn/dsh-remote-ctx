/**
 * Remote-backed `@file` completion.
 *
 * DSH resolves `@` candidates through the single-owner `ctx.fileReferences`
 * service. Its shipped provider indexes the **local** workspace directory of the
 * addressed agent; a remote workspace's cwd is a local anchor that stays empty,
 * so that provider can only ever offer `AGENTS.md` (and, before this module, a
 * synthetic placeholder tree). Mounting a second provider is not possible — the
 * service has one owner — so this module wraps `list`: a call whose agent is
 * bound to one of our anchors is answered from the remote tree over SFTP, every
 * other call is delegated to the original implementation, untouched.
 *
 * Candidates are workspace-relative POSIX paths, the same shape the local
 * provider returns and the same shape `remote_ctx_read` accepts from inside the
 * workspace. Selecting one never reads bytes: contents still go through
 * `remote_ctx_read`.
 *
 * Cost control is the whole difficulty. `@` fires on every keystroke, so the
 * remote side is reached through four bounds — entry budget, directory budget,
 * wall-clock deadline, and a short-lived index cache — and a failing host opens
 * a cooldown so a broken connection cannot make each keystroke wait for an SSH
 * timeout.
 *
 * The wrapping design and the ranking order follow dsh-remote's implementation
 * of the same seam (MIT); the code here is written against this plugin's
 * modules and its SFTP facade.
 */

/**
 * Directory basenames never traversed for `@`.
 *
 * The list is the local provider's, extended with the names our own walker and
 * mirror already ignore, so the remote namespace hides exactly the noise the
 * rest of the plugin hides.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage',
  'target', '.next', '.nuxt', '.turbo', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.gradle', '.dsh', 'vendor',
]);

/** Defaults for one remote completion surface. Conservative on purpose: `@` is latency-critical. */
export const FILE_REFERENCE_DEFAULTS = Object.freeze({
  maxResults: 20,
  maxEntries: 3000,
  maxDirs: 300,
  timeoutMs: 4000,
  cacheTtlMs: 10000,
  failureCooldownMs: 30000,
});

/**
 * Rank candidates for one query.
 *
 * Order: exact name, name prefix, name substring, path substring, then a
 * subsequence score. Directories win ties because completion descends through
 * them, and a shorter path wins the next tie. The exact sequence matches the
 * local provider, so a remote listing does not feel different from a local one.
 *
 * @param {Array<{path: string, kind: string}>} candidates
 * @param {string} query
 * @param {number} limit
 * @returns {Array<{path: string, kind: string}>}
 */
export function rankCandidates(candidates, query, limit) {
  const ranked = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score !== undefined) ranked.push({ candidate, score });
  }
  ranked.sort((left, right) => right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path));
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

function scoreCandidate(candidate, query) {
  if (query === '') return 0;
  const path = candidate.path.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const needle = query.toLowerCase();
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0;
  if (name === needle) return 1000 + directoryBonus;
  if (name.startsWith(needle)) return 900 + directoryBonus;
  if (name.includes(needle)) return 700 + directoryBonus;
  if (path.includes(needle)) return 500 + directoryBonus;
  const subsequence = subsequenceScore(path, needle);
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus;
}

function subsequenceScore(target, query) {
  let targetIndex = 0;
  let gap = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found < 0) return undefined;
    gap += found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(0, 100 - gap);
}

function kindRank(kind) {
  return kind === 'directory' ? 0 : 1;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A dot-prefixed segment stays out of a bare query unless the query asks for one. */
function visibleForGlobalQuery(path, query) {
  if (query.startsWith('.') || query.includes('/.')) return true;
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Whether a workspace-relative directory is safe to resolve.
 *
 * `..` would escape the remote workspace root and an absolute prefix would
 * ignore it entirely, so both are refused here rather than at the SFTP call.
 */
export function isSafeRelativeDir(relative) {
  const value = String(relative ?? '');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '..');
}

/**
 * A cancellable, cached index of one remote workspace.
 *
 * `listDir(relativeDirectory)` is injected and returns the direct children of a
 * workspace-relative directory (`''` is the workspace root) as
 * `{ name, kind: 'file' | 'directory' }`. It must **not** open a connection:
 * completion is not allowed to wait for an SSH handshake. Everything else here
 * is pure logic, which is what the unit tests exercise without a server.
 */
export class RemoteWorkspaceIndex {
  /**
   * @param {object} options
   * @param {(relativeDirectory: string) => Promise<Array<{name: string, kind: string}>>} options.listDir
   * @param {number} [options.maxResults]
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxDirs]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.cacheTtlMs]
   * @param {string[]} [options.excludedDirectories]
   * @param {(error: unknown) => void} [options.onError]
   * @param {() => number} [options.now]
   */
  constructor({
    listDir,
    maxResults = FILE_REFERENCE_DEFAULTS.maxResults,
    maxEntries = FILE_REFERENCE_DEFAULTS.maxEntries,
    maxDirs = FILE_REFERENCE_DEFAULTS.maxDirs,
    timeoutMs = FILE_REFERENCE_DEFAULTS.timeoutMs,
    cacheTtlMs = FILE_REFERENCE_DEFAULTS.cacheTtlMs,
    excludedDirectories = DEFAULT_EXCLUDED_DIRECTORIES,
    onError,
    now = () => Date.now(),
  } = {}) {
    this.listDir = listDir;
    this.maxResults = maxResults;
    this.maxEntries = maxEntries;
    this.maxDirs = maxDirs;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.excluded = new Set(excludedDirectories);
    this.onError = onError;
    this.now = now;
    /** Settled index plus the time its traversal started. */
    this.settled = undefined;
    /** Single-flight traversal. */
    this.generation = undefined;
    /** Monotonic invalidation counter; a settled index below it is stale. */
    this.invalidations = 0;
    this.disposed = false;
    /** True once a traversal stopped on a budget instead of finishing. */
    this.truncated = false;
  }

  /**
   * Candidates for the active `@` token.
   * @param {string} rawQuery - path text after `@` (or `@"`).
   * @param {AbortSignal} [signal] - cancels this caller's wait, not a shared traversal.
   */
  async list(rawQuery, signal) {
    throwIfAborted(signal);
    if (this.disposed) return [];
    const query = String(rawQuery ?? '').replaceAll('\\', '/');
    const slash = query.lastIndexOf('/');
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1);
      const fragment = slash < 0 ? '' : query.slice(slash + 1);
      return this.listDirectory(directory, fragment, signal);
    }
    const entries = await this.indexFor(signal);
    throwIfAborted(signal);
    return rankCandidates(entries.filter((candidate) => visibleForGlobalQuery(candidate.path, query)), query, this.maxResults);
  }

  /** Rebuild the next time a bare query arrives: our own tools changed the tree. */
  invalidate() {
    if (this.disposed) return;
    this.invalidations += 1;
  }

  /** Abort the traversal and make later queries return nothing. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.generation) this.generation.controller.abort(new Error('remote file-reference index disposed'));
    this.generation = undefined;
    this.settled = undefined;
  }

  /** Direct children of one workspace-relative directory. */
  async listDirectory(displayDirectory, fragment, signal) {
    throwIfAborted(signal);
    const relative = displayDirectory.replace(/\/+$/, '');
    if (!isSafeRelativeDir(relative)) return [];
    if (relative.split('/').some((segment) => this.excluded.has(segment))) return [];
    const items = await this.readDir(relative);
    throwIfAborted(signal);
    const candidates = [];
    for (const item of items) {
      const name = String(item?.name ?? '');
      if (!name || name === '.' || name === '..') continue;
      if (name.startsWith('.') && !String(fragment).startsWith('.')) continue;
      const kind = item.kind === 'directory' ? 'directory' : 'file';
      if (kind === 'directory' && this.excluded.has(name)) continue;
      candidates.push({ path: `${displayDirectory}${name}`, kind });
    }
    return rankCandidates(candidates, fragment, this.maxResults);
  }

  /**
   * Entries a bare (slash-free) fuzzy query ranks.
   *
   * Only the first query of a workspace waits for the traversal; afterwards a
   * stale index answers immediately and its replacement builds behind the caret.
   * Staleness is either an explicit invalidation (a tool of ours changed the
   * tree) or the cache TTL (something else on the target changed it).
   */
  async indexFor(signal) {
    const settled = this.settled;
    if (settled === undefined) return waitFor(this.ensureIndex(), signal);
    if (settled.version < this.invalidations || this.now() - settled.builtAt > this.cacheTtlMs) {
      this.ensureIndex().catch(() => {});
    }
    return settled.entries;
  }

  /** Start (or join) the single in-flight traversal. */
  ensureIndex() {
    if (this.disposed) return Promise.resolve([]);
    if (this.generation !== undefined) return this.generation.promise;
    const controller = new AbortController();
    const version = this.invalidations;
    const generation = { controller, promise: Promise.resolve([]) };
    this.generation = generation;
    generation.promise = this.scan(controller.signal).then((entries) => {
      if (this.generation === generation) this.generation = undefined;
      if (this.disposed) return entries;
      this.settled = { entries, version, builtAt: this.now() };
      return entries;
    }, (error) => {
      if (this.generation === generation) this.generation = undefined;
      throw error;
    });
    return generation.promise;
  }

  /** Breadth-first, bounded traversal of the remote tree. */
  async scan(signal) {
    const entries = [];
    const deadline = this.now() + this.timeoutMs;
    const directories = [''];
    let visited = 0;
    for (let cursor = 0; cursor < directories.length; cursor += 1) {
      throwIfAborted(signal);
      if (entries.length >= this.maxEntries || visited >= this.maxDirs || this.now() > deadline) {
        this.truncated = true;
        break;
      }
      const relative = directories[cursor];
      visited += 1;
      let items;
      try {
        // eslint-disable-next-line no-await-in-loop
        items = await this.readDir(relative);
      } catch (error) {
        // An unreachable root is a connection problem, not a missing subtree:
        // surface it so the caller can open the cooldown. A missing subdirectory
        // (deleted between listing and descent) just contributes nothing.
        if (relative === '') throw error;
        this.onError?.(error);
        continue;
      }
      for (const item of items) {
        throwIfAborted(signal);
        const name = String(item?.name ?? '');
        if (!name || name === '.' || name === '..') continue;
        const path = relative === '' ? name : `${relative}/${name}`;
        if (item.kind === 'directory') {
          if (this.excluded.has(name)) continue;
          entries.push({ path, kind: 'directory' });
          directories.push(path);
        } else {
          entries.push({ path, kind: 'file' });
        }
        if (entries.length >= this.maxEntries) {
          this.truncated = true;
          break;
        }
      }
    }
    return entries;
  }

  async readDir(relative) {
    const items = await this.listDir(relative);
    return Array.isArray(items) ? items : [];
  }
}

/**
 * One remote workspace's discovery provider, plus the cooldown that keeps a
 * broken host from stalling every keystroke.
 *
 * `list()` never rejects: it returns `null` when the cooldown is open or the
 * remote listing failed, which tells the overlay to fall back to the original
 * (local) provider instead of showing an empty list.
 */
export function createRemoteFileReference({ listDir, config = {}, onError, now } = {}) {
  const index = new RemoteWorkspaceIndex({ listDir, ...config, onError, now });
  const clock = now ?? (() => Date.now());
  const cooldownMs = config.failureCooldownMs ?? FILE_REFERENCE_DEFAULTS.failureCooldownMs;
  let downUntil = 0;
  return {
    root: config.root ?? '',
    /** False while the last failure is still cooling down. */
    ready: () => clock() >= downUntil,
    /** Called when a remote listing failed; opens the cooldown window. */
    markDown: () => { downUntil = clock() + cooldownMs; },
    async list(query, signal) {
      try {
        return await index.list(query, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        onError?.(error);
        return null;
      }
    },
    invalidate: () => index.invalidate(),
    dispose: () => index.dispose(),
  };
}

/**
 * Wrap `ctx.fileReferences.list` so anchor-bound sessions are served from the
 * remote host.
 *
 * The seam is a single-owner service, so this is an overlay rather than a second
 * provider: `resolve(agent)` returns a remote provider for an agent whose cwd is
 * one of our anchors, and `undefined` for every other agent — including a remote
 * agent whose host is cooling down, unreachable, or not connected — in which
 * case the original implementation answers with the local view.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options
 * @param {(agent: object) => ({list: Function, ready?: Function, markDown?: Function} | undefined)} options.resolve
 * @param {(error: unknown) => void} [options.onError]
 * @returns {{dispose: () => void} | undefined} teardown handle, when the seam exists.
 */
export function installFileReferenceOverlay(ctx, { resolve, onError } = {}) {
  if (!ctx || typeof ctx.inject !== 'function' || typeof resolve !== 'function') return undefined;
  const report = (error) => { try { onError?.(error); } catch { /* a logging hook must never break completion */ } };
  let restore = null;
  let fiber;
  try {
    fiber = ctx.inject(['fileReferences'], (inner) => {
      const service = inner?.fileReferences;
      if (!service || typeof service.list !== 'function') return;
      const original = service.list;
      const patched = function patchedList(agent, query, signal) {
        let remote;
        try {
          remote = resolve(agent);
        } catch (error) {
          report(error);
          remote = undefined;
        }
        // Fall back to the local provider whenever this agent is not an anchor
        // session, the feature is off, or the host is cooling down after a
        // failure: showing the synced anchor beats showing nothing.
        if (!remote || (typeof remote.ready === 'function' && !remote.ready())) {
          return original.call(service, agent, query, signal);
        }
        const fallback = () => original.call(service, agent, query, signal);
        try {
          return Promise.resolve(remote.list(String(query ?? ''), signal)).then((candidates) => {
            if (candidates === null) {
              remote.markDown?.();
              return fallback();
            }
            return candidates;
          }, (error) => {
            // An aborted keystroke is not a host failure: don't open the cooldown.
            if (signal?.aborted) throw error;
            report(error);
            remote.markDown?.();
            return fallback();
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          report(error);
          remote.markDown?.();
          return fallback();
        }
      };
      service.list = patched;
      restore = () => { if (service.list === patched) service.list = original; };
      try {
        inner.effect(() => () => { if (restore) restore(); }, 'dsh-remote-ctx: file-reference overlay');
      } catch { /* no effect registry: the returned handle still unpatches */ }
    });
  } catch (error) {
    report(error);
    return undefined;
  }
  return {
    dispose() {
      try {
        if (restore) restore();
      } catch { /* already restored */ }
      restore = null;
      try {
        fiber?.dispose?.();
      } catch { /* fiber already torn down */ }
    },
  };
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal.reason);
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('file-reference query aborted');
  error.name = 'AbortError';
  return error;
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value); },
      (error) => { signal.removeEventListener('abort', onAbort); rejectPromise(error); },
    );
  });
}
