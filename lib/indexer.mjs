/**
 * The file index.
 *
 * A walk over SFTP is slow and chatty, so it happens once and the result is
 * cached on the *local* disk — the index is workspace metadata, and workspace
 * metadata stays local by design. Searches then run against the cached entries,
 * with only the content mode going back over the wire (and only for files small
 * enough to be worth reading).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compareText } from './paths.mjs';

export const INDEX_VERSION = 1;

export const TEXT_EXTENSIONS = Object.freeze([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg', '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua', '.sql', '.graphql', '.gql', '.proto', '.env', '.lock',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerfile', '.tf', '.hcl', '.gradle', '.properties',
]);

const NO_EXTENSION_TEXT = new Set([
  'Dockerfile', 'Makefile', 'LICENSE', 'README', 'CHANGELOG', 'NOTICE', 'Procfile', 'Rakefile',
  'Gemfile', 'Cargo', 'go.mod', 'go.sum', '.gitignore', '.npmrc', '.nvmrc',
]);

export function looksTextual(path, size) {
  if (size > 512 * 1024) return false;
  const name = path.split('/').pop() ?? '';
  if (NO_EXTENSION_TEXT.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/** Walk the remote root and package the result as a cacheable index. */
export async function buildIndex(fs, options = {}) {
  const walk = await fs.walk(fs.root, {
    maxDepth: options.maxDepth,
    maxFiles: options.maxFiles,
    ignore: options.ignore,
  });
  return {
    version: INDEX_VERSION,
    connectionId: fs.connection.id,
    root: walk.root,
    builtAt: new Date().toISOString(),
    truncated: walk.truncated,
    dirsScanned: walk.dirsScanned,
    counts: countEntries(walk.entries),
    errors: walk.errors,
    entries: walk.entries,
  };
}

export function countEntries(entries) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.type === 'dir') dirs += 1;
    else {
      files += 1;
      bytes += entry.size ?? 0;
    }
  }
  return { files, dirs, bytes };
}

export function indexFilePath(dir, connectionId) {
  return join(dir, `${connectionId}.json`);
}

export function saveIndex(dir, index) {
  mkdirSync(dir, { recursive: true });
  const file = indexFilePath(dir, index.connectionId);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(index)}\n`);
  renameSync(temp, file);
  return file;
}

export function loadIndex(dir, connectionId) {
  const file = indexFilePath(dir, connectionId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function dropIndex(dir, connectionId) {
  const file = indexFilePath(dir, connectionId);
  try {
    rmSync(file, { force: true });
  } catch {
    /* nothing to drop */
  }
}

/** Short human summary for tool output and the panel. */
export function summarizeIndex(index) {
  if (!index) return { files: 0, dirs: 0, bytes: 0, builtAt: undefined, truncated: false, ageMs: undefined };
  const counts = index.counts ?? countEntries(index.entries ?? []);
  const builtAt = index.builtAt ? Date.parse(index.builtAt) : undefined;
  return {
    ...counts,
    builtAt: index.builtAt,
    truncated: Boolean(index.truncated),
    ageMs: Number.isFinite(builtAt) ? Date.now() - builtAt : undefined,
  };
}

/** Wildcards only: `*`, `**`, `?` and the zero-or-more-directory `**` + slash prefix. */
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` also matches zero directories, so `**/*.md` finds a root README.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function matcher(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return () => true;
  if (/[*?]/.test(trimmed)) {
    const regex = globToRegExp(trimmed);
    return (value) => regex.test(value);
  }
  const needle = trimmed.toLowerCase();
  return (value) => value.toLowerCase().includes(needle);
}

/**
 * Pure search over cached entries.
 *
 * `mode: 'path'` matches the whole root-relative path, `mode: 'name'` the last
 * segment only. Both prefer exact-prefix hits first so `src/` leads with the
 * files a person means.
 */
export function searchIndex(index, options = {}) {
  const mode = options.mode === 'name' ? 'name' : 'path';
  const type = ['file', 'dir'].includes(options.type) ? options.type : 'all';
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
  const test = matcher(options.query);
  const matches = [];
  for (const entry of index?.entries ?? []) {
    if (type !== 'all' && entry.type !== type) continue;
    const subject = mode === 'name' ? (entry.path.split('/').pop() ?? entry.path) : entry.path;
    if (!test(subject)) continue;
    matches.push(entry);
  }
  matches.sort((left, right) => {
    if (left.depth !== right.depth) return (left.depth ?? left.path.split('/').length) - (right.depth ?? right.path.split('/').length);
    return compareText(left.path, right.path);
  });
  return { total: matches.length, truncated: matches.length > limit, entries: matches.slice(0, limit) };
}

/**
 * Content search: reread matching files over SFTP, bounded in files, bytes and
 * hits. Only plausibly-textual files are opened.
 */
export async function searchContent(fs, index, options = {}) {
  const query = String(options.query ?? '');
  if (!query) return { filesScanned: 0, hits: [], truncated: false, skipped: 0 };
  const maxFiles = Math.max(1, Math.min(Number(options.maxFiles) || 200, 5000));
  const maxHits = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
  const maxBytes = Math.max(1024, Math.min(Number(options.maxBytes) || 262144, 8 * 1024 * 1024));
  const needle = query.toLowerCase();
  const candidates = (index?.entries ?? []).filter((entry) => entry.type === 'file' && looksTextual(entry.path, entry.size));

  const hits = [];
  let filesScanned = 0;
  let skipped = 0;
  let truncated = false;

  for (const entry of candidates) {
    if (filesScanned >= maxFiles || hits.length >= maxHits) {
      truncated = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await fs.readText(entry.path, { maxBytes }).catch(() => undefined);
    if (!result) {
      skipped += 1;
      continue;
    }
    filesScanned += 1;
    const lines = result.text.split(/\r?\n/);
    for (let number = 0; number < lines.length; number += 1) {
      if (lines[number].toLowerCase().includes(needle)) {
        hits.push({ path: entry.path, line: number + 1, text: lines[number].slice(0, 400) });
        if (hits.length >= maxHits) break;
      }
    }
  }

  return { filesScanned, hits, truncated, skipped };
}
