/**
 * Local anchors for remote workspaces.
 *
 * DSH's workspace registry owns an *existing local directory* (`realpath`, must
 * be a directory) and a session's cwd comes from that path. A remote tree has no
 * local directory, so the workspace is created over a small **anchor**: a local
 * placeholder under `$DSH_HOME/remote-ctx/workspaces/` that carries
 *
 *   - `AGENTS.md`  — instructions telling the agent that the files are remote
 *                    and that `remote_ctx_*` tools are the way to reach them;
 *   - `remote-ctx.json` — the machine-readable mapping (connection, remote
 *                    path, host), so tooling can reconstruct the link.
 *
 * The anchor is a pointer, not a copy: it stays empty, and the workspace's
 * files are read and written over SFTP. Same connection + same remote path
 * always resolves to the same anchor, so pressing "create workspace" twice is
 * idempotent and never duplicates a workspace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
root above. The agent, the session and \`$DSH_HOME\` remain on this machine; only
file bytes travel over SFTP.

\`@\` completion in this workspace reads the placeholder listing in this anchor.
It is refreshed by \`remote_ctx_index\`, by \`remote_ctx_write\` and by a sync
push; a file created on the target outside those (a shell \`touch\`, an editor)
becomes mentionable after the next refresh.
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
 * Marker line every placeholder carries.
 *
 * DSH's `@file` completion and the workspace file panel read the **local**
 * filesystem under the workspace cwd, which is the anchor. With only AGENTS.md
 * and remote-ctx.json there, `@` can never offer a remote file. So the anchor is
 * populated with a *listing*: directories exist, every remote file becomes a
 * tiny text placeholder that names its remote path and the tool that reads it.
 *
 * The placeholder is never treated as the file: it is overwritten only when it
 * still starts with this marker, so a user's local edit in the anchor survives a
 * refresh.
 */
export const PLACEHOLDER_PREFIX = '[dsh-remote-ctx] remote file:';

/** Names the anchor owns and a remote tree must not overwrite. */
const RESERVED = new Set(['AGENTS.md', MARKER_FILE]);

export function isPlaceholder(file) {
  try {
    return readFileSync(file, 'utf8').startsWith(PLACEHOLDER_PREFIX);
  } catch {
    return false;
  }
}

function placeholderText(connectionId, remotePath) {
  return `${PLACEHOLDER_PREFIX} ${remotePath}\n\n`
    + `This is a local listing entry, not the file. Read the content with:\n`
    + `  remote_ctx_read { connection: "${connectionId}", path: "${remotePath}" }\n`;
}

/** Anchor-relative segments of a path; an escaping `..` yields none. */
function anchorSegments(relativePath) {
  const segments = String(relativePath ?? '').split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.includes('..') ? [] : segments;
}

/**
 * Write one placeholder file, creating its parent directories.
 *
 * Shared by the full listing and the single-file refresh a write or a sync
 * push needs: a new remote file must become `@`-mentionable without walking
 * the whole tree.
 *
 * @param {object} options
 * @param {string} options.anchorPath anchor directory
 * @param {string} options.relativePath file path relative to the anchor
 * @param {string} options.connectionId
 * @param {string} options.remotePath absolute remote path the placeholder names
 * @returns {boolean} true when written; false when the name is reserved or a
 *          real local file already owns it.
 */
export function writePlaceholder(options) {
  const { anchorPath: root, relativePath, connectionId, remotePath } = options;
  const segments = anchorSegments(relativePath);
  if (segments.length === 0) return false;
  if (RESERVED.has(segments[segments.length - 1])) return false;
  const target = join(root, ...segments);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) && !isPlaceholder(target)) {
    // A real local file (someone edited the anchor); never clobber it.
    return false;
  }
  writeFileSync(target, placeholderText(connectionId, remotePath));
  return true;
}

/**
 * Materialise a remote listing inside an anchor.
 *
 * @param {object} options
 * @param {string} options.anchorPath  anchor directory
 * @param {Array<{path: string, type: string, size?: number}>} options.entries
 *        paths **relative to the workspace directory** (what the remote walk
 *        produced below the chosen directory)
 * @param {string} options.connectionId
 * @param {string} options.remotePrefix absolute remote directory the entries
 * @returns {{ files: number, dirs: number, skipped: number }}
 */
export function materializeListing(options) {
  const { anchorPath, entries, connectionId, remotePrefix } = options;
  let files = 0;
  let dirs = 0;
  let skipped = 0;

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (RESERVED.has(segments[segments.length - 1])) {
      skipped += 1;
      continue;
    }
    if (entry.type === 'dir') {
      mkdirSync(join(anchorPath, ...segments), { recursive: true });
      dirs += 1;
      continue;
    }
    const remotePath = remotePrefix === '/' ? `/${entry.path}` : `${remotePrefix}/${entry.path}`;
    if (writePlaceholder({ anchorPath, relativePath: entry.path, connectionId, remotePath })) files += 1;
    else skipped += 1;
  }

  return { files, dirs, skipped };
}

/**
 * The slice of a connection-root walk that sits below one workspace directory.
 *
 * `workspacePrefix` is that directory's root-relative path (`'.'` for the root
 * itself). This is what lets an anchor refresh reuse the walk a caller already
 * paid for — the find index and the `@` listing come from the same tree — so a
 * refresh costs no second SFTP traversal.
 *
 * @param {Array<{path: string, type: string}>} entries root-relative entries
 * @param {string} workspacePrefix root-relative directory, `'.'` for the root
 * @returns {Array<{path: string, type: string}>} workspace-relative entries
 */
export function entriesBelow(entries, workspacePrefix) {
  const prefix = workspacePrefix === undefined || workspacePrefix === '.' ? '' : `${workspacePrefix}/`;
  const below = [];
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || entry.path === '') continue;
    if (prefix === '') {
      below.push({ type: entry.type, path: entry.path });
    } else if (entry.path.startsWith(prefix)) {
      below.push({ type: entry.type, path: entry.path.slice(prefix.length) });
    }
  }
  return below;
}

/**
 * Every anchor under the workspaces directory, with its marker.
 *
 * A directory without a readable marker is ignored: it is not an anchor this
 * plugin owns, so a refresh must not write into it.
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
