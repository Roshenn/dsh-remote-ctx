# Architecture

`dsh-remote-ctx` is a small layered plugin. The interesting decisions are about
*where the boundary sits*: only file bytes cross the network, and only two modules
know that SSH exists.

## Layers

```
tools (lib/index.js) ─┬─ HTTP api (lib/api.mjs) ── browser panel (lib/client.js)
                      │
                      └─ RemoteContext (lib/context.mjs)
                            ├─ indexer (lib/indexer.mjs)   local cache + search
                            ├─ mirror  (lib/mirror.mjs)    local disk <-> remote
                            ├─ ssh-config (lib/ssh-config.mjs)  ~/.ssh/config -> hosts
                            ├─ paths   (lib/paths.mjs)     confinement rules
                            └─ RemoteFs (lib/remote-fs.mjs)
                                  └─ adapter
                                       ├─ ssh2-adapter (SFTP, production)
                                       └─ fake-remote  (Map, tests)
```

| Module | Responsibility | Knows about SSH? |
| --- | --- | --- |
| `lib/index.js` | Cordis contract, eight tools, workspace gate, panel mounting | no |
| `lib/api.mjs` | Prefix route `/remote-ctx`, request validation | no |
| `lib/client.js` | Sidebar entry + page; fetch only | no |
| `lib/context.mjs` | Connection records, pooled `RemoteFs`, index lifecycle | no |
| `lib/indexer.mjs` | Walk packaging, cache file, path/name/content search | no |
| `lib/mirror.mjs` | Local walk, push/pull plans, application | no |
| `lib/ssh-config.mjs` | Parses `~/.ssh/config` Host blocks into connection records | no |
| `lib/workspace.mjs` | Local anchors: marker file + AGENTS.md for a remote workspace | no |
| `lib/remote-fs.mjs` | Root resolution, confined paths, bounded reads | adapter method names only |
| `lib/ssh2-adapter.mjs` | Connect, auth, host key, SFTP calls, error mapping | **yes** |

The payoff: everything above `RemoteFs` is testable against a `Map`, and the
test suite runs the real tools, the real indexer and the real mirror with no
network and no `ssh2` install.

## One call, top to bottom

`remote_ctx_read { connection: "lan", path: "src/app.js" }`:

1. `lib/index.js` resolves the connection id (`pickConnectionId`), then asks
   `RemoteContext.remote("lan")` for a pooled session.
2. `RemoteContext` opens a `RemoteFs` through `openRemote()` if the pool entry is
   missing or older than `idleTtlMs`.
3. `RemoteFs.resolve("src/app.js")` expands `~`, joins the path under
   `remoteRoot`, normalises it, and refuses anything outside the root
   (`RemotePathError` with code `REMOTE_PATH_OUTSIDE_ROOT`).
4. `RemoteFs.readText` clamps the byte budget, then calls
   `adapter.readText(absolute, maxBytes)`.
5. The SFTP adapter opens the file, reads at most `maxBytes`, and reports
   `truncated` when the file was longer.
6. `lib/format.mjs` renders a table or a fenced block; the tool returns
   `{ text, ok, bytes, truncated }`.

Errors from steps 3–5 surface as thrown errors (the model sees a failed call,
not a silent empty result). Batch-shaped operations — index walks, mirrors — do
the opposite and report per-file failures as rows.

## Path rules

`remoteRoot` is stored as written (`~`, `~/work`, `/srv/work`) and expanded
against the remote login home at connect time, so moving a checkout to another
user does not pin the old home.

`resolveWithinRoot` is the only constructor of a path handed to SFTP:

- `~` and `~/x` expand against the remote home;
- a relative path is joined under the root, never against the remote cwd;
- the result is `posix.normalize`d, then checked with a separator-aware prefix
  test (`/srv/work` does not contain `/srv/work-other`);
- `..` escapes and absolute paths outside the root throw.

## Connection lifecycle

```
add/update ──▶ connections.json (0600)
                    │
first tool call ────┴──▶ pool: RemoteFs(adapter)
                              │  lastUsed touched on every operation
                              │
              idle > idleTtlMs ──▶ closed; next call reconnects
```

`ssh2` is imported inside `createSsh2Adapter`, not at module scope: a checkout
with no `node_modules` still loads the plugin, and every tool that needs a
connection reports `SSH2_MISSING` with the fix instead of a load-time crash.

### Auth

- **password** — `password` plus `tryKeyboard: true`; a server that only offers
  keyboard-interactive is answered with the same secret.
- **key** — the file is read from the local machine (path or `~`), then parsed
  by ssh2; `passphrase` is passed through when stored. A missing or
  unparseable key fails before any network round trip (`SSH_KEY_UNREADABLE`).
- **agent** — `auth.agent` or `SSH_AUTH_SOCK`; Windows named-pipe OpenSSH
  agent is not a socket ssh2 can open, so it is reported as
  `SSH_AGENT_MISSING`.

A rejected method becomes `SSH_AUTH_FAILED` with the target, the method and the
fix; ssh2 own "All configured authentication methods failed" is never surfaced
alone. `test/ssh-auth.test.mjs` drives these paths against an in-process ssh2
server and skips when the dependency is absent.

### Host-key trust

The adapter always installs a `hostVerifier`: it records the `SHA256:` the
server presented, and — when the connection pins `hostFingerprint` — rejects a
mismatch. An unpinned connection accepts the key (ssh2's default) but the panel
can now show what it accepted: `POST /api/test` returns `fingerprint` and
`pinned`, and `POST /api/trust` stores the shown value through
`normalizeConnection`, which keeps the stored password/passphrase. Trusting
closes the pooled session, so the pin governs the next connection instead of the
one that was implicitly trusted. A refused key maps to `SSH_HOST_KEY_CHANGED`
with both fingerprints — an interception attempt and a planned re-key need the
same information to be told apart.
## Index format

`$DSH_HOME/remote-ctx/index/<connectionId>.json`:

```json
{
  "version": 1,
  "connectionId": "lan",
  "root": "/srv/workspaces/app",
  "builtAt": "2026-10-30T07:30:00.000Z",
  "truncated": false,
  "dirsScanned": 42,
  "counts": { "files": 380, "dirs": 42, "bytes": 7340032 },
  "errors": [],
  "entries": [{ "path": "src/app.js", "type": "file", "size": 2048, "mtimeMs": 1793000000000 }]
}
```

Paths are root-relative and POSIX. Entries are sorted by code unit, not locale,
so the same tree produces the same file on every machine. `node_modules`, `.git`,
`dist`, `build`, `.venv`, `target` and friends are skipped during the walk.

A write through `remote_ctx_write` drops the cached index for that connection:
a stale index that still lists a file is a smaller lie than an index that
searches old content.

The panel shows `builtAt` as an age (`3 分钟前`). `GET /api/find` reports
`stale: true` once that age passes 30 minutes (`INDEX_STALE_MS` in
`lib/api.mjs`, mirrored in `lib/client.js`), and a rebuild re-runs the search
that is open.

## Mirror semantics

`planPush(local, remoteIndex)` compares each local file against its remote
counterpart by **size**:

| Situation | Action | Reason string |
| --- | --- | --- |
| not in the remote index | upload | `missing on remote` |
| different size | upload | `size A -> B` |
| same size | skip | `same size` |
| `force: true` | upload | `forced` |

`planPull` is the mirror image. Both plans are pure functions over two entry
lists, which is why they are tested without touching a file.

Application is bounded (`concurrency: 4`), and each file resolves independently:
a failure is a row in `applied.failed`, never an aborted batch. Transfers never
delete. A pushed file is written to `<name>.dshrc-tmp-<pid>-<ts>` and renamed
into place, so a dropped connection cannot leave a truncated file behind.

## Panel

The browser half registers one left-sidebar entry (`sidebar.panellist`,
order 47) and one main page, following the ModuleLoader contract. The page is
a two-column workbench (`grid-template-columns: 288px minmax(0, 1fr)`): the
rail lists `~/.ssh/config` hosts and saved connections, the detail column holds
one of six views — `new` (the default), `detail`, `edit`, `browse`, `file`,
`mirror`.
Selecting a host only sets form state; no request is sent until the form is
submitted, so browsing the rail can never create a record:

```js
window.__ModuleLoader__.load({ id: 'dsh-remote-ctx', factory: (require) => { … } });
```

It only calls `/remote-ctx/api` with same-origin `fetch`. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | connections, live pool state, index summaries |
| GET/POST | `/api/connections` | list / create-or-update |
| GET | `/api/ssh-config` | concrete `Host` entries from `~/.ssh/config`, with an `added` flag |
| POST | `/api/workspace` | create an anchor and register it as a DSH workspace |
| POST | `/api/ssh-config/import` | create a connection from one Host alias |
| DELETE | `/api/connections?id=` | remove a record and its index |
| POST | `/api/test` | open the connection and list the root, with the presented host key |
| POST | `/api/trust` | pin the host key the test reported, keeping the stored secret |
| GET | `/api/browse?id=&path=` | one remote directory |
| GET | `/api/file?id=&path=&limit=` | one remote file: text, size, mtime, truncated, binary |
| POST | `/api/file` | atomic write; a stale `expectedMtimeMs` is `409 file-changed` |
| GET/POST | `/api/index?id=` | read the summary / rebuild |
| GET | `/api/find?id=&query=&mode=&type=&limit=` | search the cached index; reports `missing` and `stale` |
| POST | `/api/sync` | plan, and optionally apply, a push or pull |

No route accepts a path without going through `RemoteFs.resolve`, and no
response contains a password.

## Remote workspaces

DSH workspace records own a **local** directory, and a session's cwd is that path,
so a remote tree is represented by an anchor:

```
$DSH_HOME/remote-ctx/workspaces/<connection>-<sha1(connection, path)>
├── AGENTS.md        instructions: files are remote, use remote_ctx_* tools
└── remote-ctx.json  mapping: connection, host, remoteRoot, remotePath
```

`createWorkspace()` resolves the requested remote path inside the connection
root, writes the anchor, then calls `ctx.workspaceRegistry.create(anchor, title)`
when the host exposes that optional service. The service is captured through
`ctx.inject(['workspaceRegistry'], …)` at apply time — a plain property read or
`ctx.get` does not resolve a service the plugin never declared, and a static
`inject` entry would make the whole plugin wait on hosts without workspaces. The
anchor also receives a **placeholder listing** of the remote tree: the remote
walk yields directories and files, each file becomes a two-line text file
starting with `[dsh-remote-ctx] remote file: <remote path>`, and reserved names
(`AGENTS.md`, `remote-ctx.json`) are skipped. That is what makes DSH's local
`@file` completion and the workspace panel show remote paths at all.

Refresh is not a timer: it happens on the actions that change the remote tree or
are asked to rebuild it. `remote_ctx_index` reuses its own walk for every anchor
of the connection (`refreshAnchors(id, { entries })`), so a re-index costs no
second SFTP traversal; `remote_ctx_write` and a sync push upsert the one
placeholder per created file (`upsertPlaceholders`, O(1)); re-running
`remote_ctx_workspace` re-walks the whole workspace. A placeholder is overwritten
only while it still starts with the marker, so a real local edit survives. A
file created on the target outside all of those — a shell `touch`, an editor —
becomes mentionable after the next refresh trigger. Nothing is ever deleted:
placeholders for remote files that disappeared stay until the user deletes
them, because a mirror that removes files is a different product. Content is
never mirrored — reading still goes through `remote_ctx_read`.

The registry canonicalises the
anchor path, rejects a nonexistent directory and is idempotent per path; the
anchor name is a hash of (connection, remote path), so the panel and the tool
converge on one workspace. Without the registry the anchor is still created and
the caller is told to add it through the workspace picker.

### The tools belong to the remote workspace

`lib/index.js` registers the eight tools globally — the registry has no
per-workspace registration form — but it does not leave them visible
everywhere. A session whose cwd is not an anchor (a directory carrying
`remote-ctx.json`, found by `anchorContaining`) gets them removed:

- at `agent/created`, the plugin calls `tools.restrict({ deny })` through the
  new agent's own scope, so the schemas never reach that session's model;
- a plain-context `tools.guard` re-checks the cwd on every `remote_ctx_*`
  dispatch, because a restriction is applied once while `cd` can move a session
  into or out of an anchor afterwards.

The panel is not gated: it is a management surface, not a file channel, and
mirroring a local workspace onto the target starts from it. This is why the
anchor's `@` listing and `remote_ctx_*` tools are scoped to the workspace that
`remote_ctx_workspace` created, while the sidebar entry is available everywhere.

## Testing

| File | Covers |
| --- | --- |
| `test/paths.test.mjs` | normalisation, `~` expansion, every escape attempt |
| `test/config.test.mjs` | connection validation, secret boundary, 0600 store |
| `test/indexer.test.mjs` | walk, caps, glob, path/name/content search, cache round-trip |
| `test/mirror.test.mjs` | local walk, push/pull plans, application both ways |
| `test/workspace.test.mjs` | anchor naming, marker + AGENTS.md, idempotency, single-file placeholder upsert, root-walk slicing |
| `test/ssh-config.test.mjs` | `Host` parsing, first-wins, wildcards, Include, concrete-host list |
| `test/ssh2-adapter.test.mjs` | error wording, host-key change mapping, the agent-error listener staying alive |
| `test/dev-link.test.mjs` | profile wiring: dependency + bundle entry, idempotent, removable |
| `test/api.test.mjs` | the panel routes (including `/api/test` fingerprint and `/api/trust`), 400/404 mapping, secret boundary |
| `test/plugin.test.mjs` | cordis contract, eight tools, workspace gate (visible/denied/guard), end-to-end through every layer |

`test/stub/loader.mjs` resolves `@deepseek-ai/dsh-tools` to a contract stub, and
`test/fake-remote.mjs` implements the six adapter methods over a `Map`.
