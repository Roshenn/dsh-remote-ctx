# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A local workspace was offered the remote tools.** Every `remote_ctx_*` tool
  was registered globally, so a session whose workspace was an ordinary local
  directory still saw all eight in its tool list — and could be steered into the
  remote plugin for files that are local. Tools are now scoped per session:
  `agent/created` restricts the eight names for any session whose cwd is not an
  anchor (`anchorContaining`, a directory carrying `remote-ctx.json`), and a
  dispatch guard re-checks the cwd at call time because `cd` can move the
  session after creation. The panel is unchanged and remains the management
  surface — mirroring a local workspace onto the target starts there.

### Added

- **Host-key trust is explicit.** A connection test now reports the `SHA256:`
  fingerprint the target presented (the `remote_ctx_connections` test output and
  `POST /api/test` both carry it), and the connection detail offers
  **信任并固定指纹** (`POST /api/trust`). Trusting a fingerprint stores it on the
  connection without touching the stored password or passphrase, and drops the
  pooled session so the next connect is verified. A pinned key that no longer
  matches fails as `SSH_HOST_KEY_CHANGED`, naming the pinned and presented
  fingerprints, instead of a generic ssh2 error.

- **Panel search over the cached index, with its age in view.** The browse view
  gained a search box that queries the local index (`GET /api/find`) and lists
  path/name matches; a result opens the file in the panel or navigates to its
  directory. The index age is shown next to the results and in the connection
  detail, and past 30 minutes it is labelled as possibly stale; a missing or
  stale index offers a one-click rebuild that re-runs the open search.

- **A remote file opens in the panel.** Clicking a file in the directory
  browser now opens it in place: the panel reads it over SFTP (bounded by
  `maxReadBytes`, with a truncation flag and a NUL-byte check for binaries),
  shows size and mtime, and an edit saves atomically. The save posts the mtime
  the file was read at — `expectedMtimeMs` — so a file changed on the target in
  between is refused with `409 file-changed` instead of silently overwritten.
  A truncated or binary read stays read-only. The write goes through the same
  `allowRemoteWrite` switch as `remote_ctx_write`, drops the cached index and
  refreshes the workspace `@` placeholder for that path.

- **Workspace anchors carry a placeholder listing of the remote tree.** DSH's
  `@file` completion and the workspace file panel read the local workspace
  directory, so an anchor holding only `AGENTS.md` + `remote-ctx.json` could
  never offer a remote file. Creating (or re-creating) a workspace now walks the
  remote directory and writes directories plus one tiny
  `[dsh-remote-ctx] remote file:` placeholder per file, bounded by
  `maxIndexFiles`/`maxIndexDepth`. Placeholders are refreshed only when they
  still carry the marker, so a real local edit is never clobbered; content is
  still read through `remote_ctx_read`.

### Fixed

- **Files created after the workspace never reached `@`.** The placeholder
  listing was materialised only by `remote_ctx_workspace`, so a file created
  later — a `touch` in a terminal, another session's write, a sync push — stayed
  invisible to `@file` completion until the workspace was re-created.
  `remote_ctx_index` now re-materialises every anchor of the connection from the
  walk it already paid for (no second SFTP traversal), `remote_ctx_write`
  upserts one placeholder in O(1), and a push refreshes the placeholders it
  created on both the tool and the panel API. Re-running
  `remote_ctx_workspace` remains the full refresh. No file is ever deleted on
  either side; stale placeholders for deleted remote files are left alone by
  design.

- **A failed ssh-agent connection crashed the whole DSH host.** ssh2 emits two
  `error` events when the agent socket cannot be reached (the agent error, then
  `All configured authentication methods failed`). The adapter listened with
  `once('error')`, so the second error had no listener and Node threw it as an
  uncaught exception — the host exited with `dsh: fatal uncaught exception` and
  the app quit. The listener now stays attached for the client's lifetime and
  settles the connect promise once; an agent socket stored as
  `$SSH_AUTH_SOCK` is expanded (`$VAR`/`${VAR}`) before it reaches ssh2, and a
  socket that does not exist becomes `SSH_AGENT_UNREACHABLE` instead of an
  authentication failure.

## [0.2.0] — 2026-10-30

### Added

- **Remote workspaces.** `remote_ctx_workspace` (tool) and `POST /api/workspace`
  register a remote directory as a DSH workspace through a local anchor under
  `$DSH_HOME/remote-ctx/workspaces/`. The anchor carries `remote-ctx.json`
  (connection, host, remote path) and an `AGENTS.md` that routes file work to
  the `remote_ctx_*` tools; `ctx.workspaceRegistry.create()` is called lazily
  and stays optional, so a headless host still creates the anchor.
- Panel: **创建为工作区** in the directory browser and **创建工作区** in the
  connection detail.

### Added

- **Keyboard-interactive password auth** — servers that expose password login
  only through PAM/2FA prompts now work: the adapter answers each prompt with
  the stored password (`tryKeyboard` + a `keyboard-interactive` handler).
- **Real-socket auth tests** — an in-process `ssh2` server exercises correct
  password, rejected password, keyboard-interactive-only, private-key and
  missing-key paths (`test/ssh-auth.test.mjs`, skipped when `ssh2` is absent).

### Fixed

- **"workspace 注册服务不可用" on a host that clearly has workspaces.** A plain
  property read (`ctx.workspaceRegistry`) and `ctx.get` do not resolve a service
  the plugin never declared, so the registry was always `undefined`. It is now
  captured through `ctx.inject(['workspaceRegistry'], …)` — the same optional
  pattern the panel uses for `webServer` — while staying non-mandatory for hosts
  without workspaces.

- **Auth failures are actionable.** "All configured authentication methods
  failed" is replaced by `SSH_AUTH_FAILED` naming the target, the method that
  was tried and the server-side check that fixes it; key read/parse failures
  become `SSH_KEY_UNREADABLE` with the local path and passphrase hint; the
  panel prefixes known codes with a Chinese one-liner (`lib/ssh2-adapter.mjs`,
  `lib/client.js`).

### Changed

- **Remote context is a two-column workbench.** The rail lists every
  `~/.ssh/config` Host and every saved connection; the right column opens on the
  connection form instead of an empty state. Picking a host prefills the form
  (nothing is written until 连接), a successful connect switches the column to
  that connection's detail (test / browse / mirror / edit / delete), and browse
  and mirror now open inside the column with a back button. All UI copy is
  Chinese; the private-key form gained an optional passphrase field.

### Fixed

- Saving a key-based connection with the passphrase field left empty keeps the
  stored passphrase instead of wiping it — the same rule the password field
  already followed.

### Added

- **`~/.ssh/config` discovery** — `lib/ssh-config.mjs` parses the Host blocks a
  user already has (HostName / User / Port / IdentityFile / ProxyJump, `Include`
  files, `*` and `!` patterns, first-obtained-value-wins) and the panel lists
  them under **From ~/.ssh/config** with a one-click **Add**. New
  `remote_ctx_connections` actions `discover` and `import`, new routes
  `GET /api/ssh-config` and `POST /api/ssh-config/import`, new config field
  `sshConfigFile`. Hosts with ProxyJump/ProxyCommand are listed but cannot be
  imported: the adapter opens direct SFTP sessions only.

### Added

- `scripts/dev-link.mjs` (`npm run dev-link`) — wires this checkout into a DSH
  profile as a `link:` dependency plus a `dsh.profile.bundles` entry, the same
  install shape `dsh-looptree-dashboard` uses, with `--dry-run`, `--remove` and
  `--install`. Needed because the desktop profile is shell-managed and cannot be
  installed with `dsh plugin`.

### Fixed

- Documented that a `link:` install keeps its own `node_modules`: the profile
  never installs this package's `ssh2`, so `npm install --no-package-lock` in the
  checkout is part of the dev install, not an extra.

## [0.1.0] — 2026-10-30

First working release: a minimal remote-context bridge over plain SSH.

### Added

- **Host half** (`lib/index.js`) — a cordis plugin registering seven tools over
  the `tools` service: `remote_ctx_connections`, `remote_ctx_ls`,
  `remote_ctx_read`, `remote_ctx_write`, `remote_ctx_index`, `remote_ctx_find`,
  `remote_ctx_sync`.
- **SFTP transport** (`lib/ssh2-adapter.mjs`) — `ssh2` is imported lazily; key,
  password and ssh-agent auth; optional pinned host fingerprint; keepalive and
  an idle connection pool.
- **Path confinement** (`lib/paths.mjs`) — every remote path is normalised and
  proven inside the connection's `remoteRoot` before an SFTP call; `..`,
  absolute escapes and `~` expansion are covered by tests.
- **Local file index** (`lib/indexer.mjs`) — the remote tree is walked once,
  cached under `$DSH_HOME/remote-ctx/index/`, and searched by path, name or
  content with `*`, `**` and `?` wildcards.
- **Mirror** (`lib/mirror.mjs`) — push a local workspace to the remote or pull it
  back over SFTP; size-based comparison, `force`, `dryRun`, and never a delete.
- **Sidebar panel** (`lib/client.js`) — connection list and form, remote
  directory browser, index button, and a mirror runner talking to
  `/remote-ctx/api`.
- **HTTP API** (`lib/api.mjs`) — same-origin JSON routes used by the panel; the
  only shape that leaves the host half never contains a password.
- **Tests** — 53 tests, no network and no dependencies: the adapter is
  in-memory, the `dsh-tools` peer dependency is stubbed through a loader hook.

### Known limits

- No command execution, PTY or git on the target — this is a context bridge, not
  a remote shell. Use [`dsh-remote-ssh`](https://github.com/Roshenn/dsh-remote-ssh)
  when commands must run remotely too.
- No deletion in either mirror direction, by design.
- Up-to-date detection compares size, not content hash.
