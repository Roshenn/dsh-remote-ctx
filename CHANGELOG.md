# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
