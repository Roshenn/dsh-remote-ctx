# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Tests** — 45 tests, no network and no dependencies: the adapter is
  in-memory, the `dsh-tools` peer dependency is stubbed through a loader hook.

### Known limits

- No command execution, PTY or git on the target — this is a context bridge, not
  a remote shell. Use [`dsh-remote-ssh`](https://github.com/Roshenn/dsh-remote-ssh)
  when commands must run remotely too.
- No deletion in either mirror direction, by design.
- Up-to-date detection compares size, not content hash.
