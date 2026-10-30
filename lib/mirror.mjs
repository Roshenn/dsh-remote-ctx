/**
 * Workspace mirror: move a local workspace's files onto the remote host over
 * SFTP, and pull remote changes back.
 *
 * The rules are deliberately conservative:
 *   - nothing is ever deleted on either side (a mirror that removes files is a
 *     different, more dangerous product);
 *   - a file is up to date when its size matches, unless `force` is set — *     SFTP cannot carry an mtime comparison cheaply on every platform, and
 *     pretending it can is worse than documenting the one metric used;
 *   - every file is a row in the report: one failure never aborts the batch.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';
import { DEFAULT_IGNORE } from './remote-fs.mjs';
import { compareText } from './paths.mjs';

export async function walkLocal(root, options = {}) {
  const base = resolve(root);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 20000;
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const entries = [];
  const errors = [];
  const queue = [{ dir: base, depth: 0 }];
  let truncated = false;
  let dirsScanned = 0;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) {
      truncated = true;
      continue;
    }
    let names;
    try {
      // eslint-disable-next-line no-await-in-loop
      names = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: dir, message: error?.message ?? String(error) });
      continue;
    }
    dirsScanned += 1;
    for (const dirent of names) {
      if (ignore.has(dirent.name)) continue;
      if (entries.length >= maxFiles) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const absolute = join(dir, dirent.name);
      const relative = absolute.slice(base.length + 1).split('\\').join('/');
      if (dirent.isDirectory()) {
        entries.push({ path: relative, type: 'dir', size: 0, mtimeMs: 0 });
        queue.push({ dir: absolute, depth: depth + 1 });
      } else if (dirent.isFile()) {
        let info;
        try {
          // eslint-disable-next-line no-await-in-loop
          info = await stat(absolute);
        } catch (error) {
          errors.push({ path: absolute, message: error?.message ?? String(error) });
          continue;
        }
        entries.push({ path: relative, type: 'file', size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }

  entries.sort((left, right) => compareText(left.path, right.path));
  return { root: base, entries, truncated, dirsScanned, errors, maxFiles, maxDepth };
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Decide which local files should be uploaded.
 *
 * `index` is the remote index (cached walk). A path missing from it, or present
 * with a different size, is uploaded. `force` re-uploads everything matched.
 */
export function planPush(local, index, options = {}) {
  const force = options.force === true;
  const remote = new Map((index?.entries ?? []).filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  const rows = [];
  let bytes = 0;
  for (const file of local.entries.filter((entry) => entry.type === 'file')) {
    const current = remote.get(file.path);
    if (force) {
      rows.push({ action: 'upload', path: file.path, size: file.size, reason: 'forced', from: current?.size });
      bytes += file.size;
      continue;
    }
    if (!current) {
      rows.push({ action: 'upload', path: file.path, size: file.size, reason: 'missing on remote' });
      bytes += file.size;
      continue;
    }
    if ((current.size ?? 0) !== (file.size ?? 0)) {
      rows.push({ action: 'upload', path: file.path, size: file.size, reason: `size ${current.size ?? 0} -> ${file.size ?? 0}`, from: current.size });
      bytes += file.size;
      continue;
    }
    rows.push({ action: 'skip', path: file.path, size: file.size, reason: 'same size' });
  }
  return {
    direction: 'push',
    rows,
    uploads: rows.filter((row) => row.action === 'upload'),
    skipped: rows.filter((row) => row.action === 'skip'),
    bytes,
    truncated: Boolean(local.truncated),
  };
}

/** Mirror of `planPush`, from the remote index down to local files. */
export function planPull(index, local, options = {}) {
  const force = options.force === true;
  const localFiles = new Map(local.entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  const rows = [];
  let bytes = 0;
  for (const remote of (index?.entries ?? []).filter((entry) => entry.type === 'file')) {
    const current = localFiles.get(remote.path);
    if (force) {
      rows.push({ action: 'download', path: remote.path, size: remote.size, reason: 'forced', from: current?.size });
      bytes += remote.size;
      continue;
    }
    if (!current) {
      rows.push({ action: 'download', path: remote.path, size: remote.size, reason: 'missing locally' });
      bytes += remote.size;
      continue;
    }
    if ((current.size ?? 0) !== (remote.size ?? 0)) {
      rows.push({ action: 'download', path: remote.path, size: remote.size, reason: `size ${current.size ?? 0} -> ${remote.size ?? 0}`, from: current.size });
      bytes += remote.size;
      continue;
    }
    rows.push({ action: 'skip', path: remote.path, size: remote.size, reason: 'same size' });
  }
  return {
    direction: 'pull',
    rows,
    downloads: rows.filter((row) => row.action === 'download'),
    skipped: rows.filter((row) => row.action === 'skip'),
    bytes,
    truncated: Boolean(index?.truncated),
  };
}

async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function applyPush(fs, plan, options = {}) {
  const localRoot = resolve(options.localRoot ?? '.');
  const concurrency = Number.isInteger(options.concurrency) ? options.concurrency : 4;
  const results = await pool(plan.uploads, concurrency, async (row) => {
    try {
      const absolute = join(localRoot, ...row.path.split('/'));
      const body = await readFile(absolute);
      await fs.writeText(fs.absolute(row.path), body.toString('utf8'));
      return { path: row.path, ok: true, bytes: body.length };
    } catch (error) {
      return { path: row.path, ok: false, error: error?.message ?? String(error) };
    }
  });
  return summarizeApply('push', results, plan);
}

export async function applyPull(fs, plan, options = {}) {
  const localRoot = resolve(options.localRoot ?? '.');
  const concurrency = Number.isInteger(options.concurrency) ? options.concurrency : 4;
  const results = await pool(plan.downloads, concurrency, async (row) => {
    try {
      const remote = await fs.readText(fs.absolute(row.path), { maxBytes: 8 * 1024 * 1024 });
      const absolute = join(localRoot, ...row.path.split('/'));
      await mkdir(dirname(absolute), { recursive: true });
      const temp = `${absolute}.dshrc-tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, remote.text, 'utf8');
      await rename(temp, absolute);
      const info = await stat(absolute);
      return { path: row.path, ok: true, bytes: info.size, truncated: remote.truncated };
    } catch (error) {
      return { path: row.path, ok: false, error: error?.message ?? String(error) };
    }
  });
  return summarizeApply('pull', results, plan);
}

export function summarizeApply(direction, results, plan) {
  const ok = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  return {
    direction,
    results,
    ok,
    failed,
    bytes: ok.reduce((total, row) => total + (row.bytes ?? 0), 0),
    skipped: plan.skipped.length,
  };
}

/** Normalise a workspace-relative path for comparisons (POSIX, no `./`). */
export function normalizeRelative(path) {
  return posix.normalize(String(path).split('\\').join('/')).replace(/^\.\//, '');
}
