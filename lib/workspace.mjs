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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
