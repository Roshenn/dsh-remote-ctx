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
                            ├─ paths   (lib/paths.mjs)     confinement rules
                            └─ RemoteFs (lib/remote-fs.mjs)
                                  └─ adapter
                                       ├─ ssh2-adapter (SFTP, production)
                                       └─ fake-remote  (Map, tests)
```

| Module | Responsibility | Knows about SSH? |
| --- | --- | --- |
| `lib/index.js` | Cordis contract, seven tools, panel mounting | no |
| `lib/api.mjs` | Prefix route `/remote-ctx`, request validation | no |
| `lib/client.js` | Sidebar entry + page; fetch only | no |
| `lib/context.mjs` | Connection records, pooled `RemoteFs`, index lifecycle | no |
| `lib/indexer.mjs` | Walk packaging, cache file, path/name/content search | no |
| `lib/mirror.mjs` | Local walk, push/pull plans, application | no |
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
order 47) and one main page, following the ModuleLoader contract:

```js
window.__ModuleLoader__.load({ id: 'dsh-remote-ctx', factory: (require) => { … } });
```

It only calls `/remote-ctx/api` with same-origin `fetch`. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | connections, live pool state, index summaries |
| GET/POST | `/api/connections` | list / create-or-update |
| DELETE | `/api/connections?id=` | remove a record and its index |
| POST | `/api/test` | open the connection and list the root |
| GET | `/api/browse?id=&path=` | one remote directory |
| GET/POST | `/api/index?id=` | read the summary / rebuild |
| POST | `/api/sync` | plan, and optionally apply, a push or pull |

No route accepts a path without going through `RemoteFs.resolve`, and no
response contains a password.

## Testing

| File | Covers |
| --- | --- |
| `test/paths.test.mjs` | normalisation, `~` expansion, every escape attempt |
| `test/config.test.mjs` | connection validation, secret boundary, 0600 store |
| `test/indexer.test.mjs` | walk, caps, glob, path/name/content search, cache round-trip |
| `test/mirror.test.mjs` | local walk, push/pull plans, application both ways |
| `test/api.test.mjs` | the seven panel routes, 400/404 mapping, secret boundary |
| `test/plugin.test.mjs` | cordis contract, seven tools, end-to-end through every layer |

`test/stub/loader.mjs` resolves `@deepseek-ai/dsh-tools` to a contract stub, and
`test/fake-remote.mjs` implements the six adapter methods over a `Map`.
