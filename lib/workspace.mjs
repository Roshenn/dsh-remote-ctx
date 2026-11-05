/**
 * Local anchors for remote workspaces.
 *
 * DSH's workspace registry owns an *existing local directory* (`realpath`, must
 * be a directory) and a session's cwd comes from that path. A remote tree has no
 * local directory, so the workspace is created over a small **anchor**: a local
 * pointer under `$DSH_HOME/remote-ctx/workspaces/` that carries
 *
 *   - `AGENTS.md`  — instructions telling the agent that the files are remote
 *                    and that `remote_ctx_*` tools are the way to reach them;
 *   - `remote-ctx.json` — the machine-readable mapping (connection, remote
 *                    path, host), so tooling can reconstruct the link.
 *
 * The anchor is a pointer, not a copy: it holds no workspace files, and `@`
 * completion asks the remote host directly (see `lib/file-reference.mjs`) rather
 * than reading a local listing. Same connection + same remote path always
 * resolves to the same anchor, so pressing "create workspace" twice is
 * idempotent and never duplicates a workspace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { slugify } from './paths.mjs';

export const MARKER_FILE = 'remote-ctx.json';
export const ANCHOR_INSTRUCTIONS = 'AGENTS.md';

/** Stable anchor directory name for one (connection, remote path) pair. */
export function anchorName(connectionId, remotePath) {
  const digest = createHash('sha1').update(`${connectionId}\0${remotePath}`).digest('hex').slice(0, 10);
  return `${slugify(connectionId)}-${digest}`;
}

export function anchorPath(workspacesDir, connectionId, remotePath) {
  return join(workspacesDir, anchorName(connectionId, remotePath));
}

function instructions(marker) {
  return `# Remote workspace: ${marker.label} → ${marker.remotePath}

This directory is a **local anchor**, not the project. The files live on the
remote host; this folder stays empty on purpose.

- connection: \`${marker.connectionId}\` (${marker.user ? `${marker.user}@` : ''}${marker.host}:${marker.port})
- remote root: \`${marker.remoteRoot}\`
- remote path: \`${marker.remotePath}\`

## Working here

Use the plugin's tools for anything file-related — the standard file tools see
this empty local directory, not the remote tree:

| Task | Tool |
| --- | --- |
| list a directory | \`remote_ctx_ls\` |
| read a file | \`remote_ctx_read\` |
| write a file | \`remote_ctx_write\` |
| refresh the file index | \`remote_ctx_index\` |
| search paths, names, contents | \`remote_ctx_find\` |
| push/pull a local directory | \`remote_ctx_sync\` |

Pass \`connection: "${marker.connectionId}"\` and paths relative to the remote
path above — that is also the spelling \`@\` completion offers. The agent, the
session and \`$DSH_HOME\` remain on this machine; only file bytes travel over
SFTP.

\`@\` completion in this workspace lists the **live remote tree**: the plugin
answers DSH's file-reference service from the target, within a few seconds of
the file appearing there. Selecting a path inserts it as text only — open it
with \`remote_ctx_read\`; the built-in read tool cannot see the remote files.
`;
}

/**
 * Create (or reuse) the anchor for one remote directory.
 *
 * @param {object} options
 * @param {string} options.workspacesDir directory that holds every anchor
 * @param {object} options.connection  normalised connection record
 * @param {string} options.remotePath  absolute remote directory (already confined)
 * @returns {{ path: string, markerFile: string, created: boolean, marker: object }}
 */
export function createAnchor(options) {
  const { workspacesDir, connection, remotePath } = options;
  const path = anchorPath(workspacesDir, connection.id, remotePath);
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true });

  const markerFile = join(path, MARKER_FILE);
  let marker;
  if (existsSync(markerFile)) {
    try {
      marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    } catch {
      marker = undefined;
    }
  }
  marker = {
    version: 1,
    connectionId: connection.id,
    label: connection.label ?? connection.id,
    host: connection.host,
    port: connection.port,
    user: connection.username ?? undefined,
    remoteRoot: connection.remoteRoot,
    remotePath,
    createdAt: marker?.createdAt ?? new Date().toISOString(),
  };
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  writeFileSync(join(path, ANCHOR_INSTRUCTIONS), instructions(marker));
  return { path, markerFile, created, marker };
}

/** Read the mapping back out of an anchor (for tests and future tooling). */
export function readAnchor(path) {
  try {
    return JSON.parse(readFileSync(join(path, MARKER_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The anchor that contains a local directory, if any.
 *
 * A session's cwd is normally the anchor itself, but `cd` can leave it in a
 * subdirectory; the marker is the source of truth either way. The search stops
 * at the workspaces directory so a stray `remote-ctx.json` elsewhere on disk
 * cannot promote an ordinary local workspace to a remote one.
 *
 * @param {string} directory absolute local directory
 * @param {string} workspacesDir directory that holds every anchor
 * @returns {{ path: string, marker: object } | undefined}
 */
export function anchorContaining(directory, workspacesDir) {
  if (typeof directory !== 'string' || directory === '') return undefined;
  if (typeof workspacesDir !== 'string' || workspacesDir === '') return undefined;
  const root = resolve(workspacesDir);
  const candidate = resolve(directory);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  let current = candidate;
  while (current !== root) {
    const marker = readAnchor(current);
    if (marker && typeof marker.connectionId === 'string' && typeof marker.remotePath === 'string') {
      return { path: current, marker };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Marker line every placeholder file carried before completion moved to the
 * remote tree. Kept only so a re-created workspace can prune them: deleting a
 * file we wrote is safe, deleting anything else is not.
 */
export const PLACEHOLDER_PREFIX = '[dsh-remote-ctx] remote file:';

export function isPlaceholder(file) {
  try {
    return readFileSync(file, 'utf8').startsWith(PLACEHOLDER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Remove the placeholder files an older version wrote into an anchor.
 *
 * Up to 0.2.0 the anchor held one tiny file per remote file so DSH's local
 * provider could list them. That is now the remote provider's job, so the fake
 * tree is noise: it shows files that no longer exist and hides the live ones.
 * Only a file whose content still starts with the marker is removed — a local
 * edit in the anchor is the user's, not ours to discard — and a directory that
 * ends up empty is removed with it. The anchor itself is never removed.
 *
 * @param {string} anchorPath anchor directory
 * @returns {number} files removed
 */
export function prunePlaceholderFiles(anchorPath) {
  let removed = 0;
  const walk = (directory) => {
    let dirents;
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const path = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        walk(path);
        try {
          if (readdirSync(path).length === 0) rmdirSync(path);
        } catch {
          /* a directory someone is using stays */
        }
        continue;
      }
      if (!dirent.isFile() || !isPlaceholder(path)) continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        /* an unreadable placeholder is not worth failing a workspace over */
      }
    }
  };
  walk(anchorPath);
  return removed;
}

/**
 * Every anchor under the workspaces directory, with its marker.
 *
 * A directory without a readable marker is ignored: it is not an anchor this
 * plugin owns, so nothing may write into it.
 *
 * @param {string} workspacesDir
 * @returns {Array<{ path: string, markerFile: string, marker: object }>}
 */
export function listAnchors(workspacesDir) {
  let dirents;
  try {
    dirents = readdirSync(workspacesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const anchors = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const path = join(workspacesDir, dirent.name);
    const marker = readAnchor(path);
    if (!marker || typeof marker.connectionId !== 'string' || typeof marker.remotePath !== 'string') continue;
    anchors.push({ path, markerFile: join(path, MARKER_FILE), marker });
  }
  return anchors;
}
