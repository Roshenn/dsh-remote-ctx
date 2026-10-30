# Contributing

## Scope

The project is deliberately small. Changes that make it bigger need a reason
that survives this list:

- **No command execution.** This is a context bridge; `dsh-remote-ssh` owns
  remote commands. A PR that shells out over SSH will be declined.
- **No deletion.** Neither mirror direction deletes. If you need it, open an
  issue explaining the safety model first.
- **No new runtime dependencies** without a paragraph on why the platform cannot
  do it. `ssh2` is the only one, and it is lazily imported.
- **No build step.** Plain ESM files under `lib/`, loaded as-is.

## Setup

```bash
git clone https://github.com/Roshenn/dsh-remote-ctx
cd dsh-remote-ctx
node --test "test/*.test.mjs"
```

No `npm install` is needed: `@deepseek-ai/dsh-tools` is stubbed through a loader
hook (`test/stub/loader.mjs`) and the remote side is an in-memory adapter
(`test/fake-remote.mjs`).

## Before opening a PR

```bash
node --test "test/*.test.mjs"   # all green
node scripts/check.mjs          # manifest, patch row, exports, license
node scripts/smoke.mjs          # prints the resolved config
```

A change to behaviour needs a test that fails without it. A change to a path
rule, a write path, or the secret boundary needs a test in
`test/paths.test.mjs` / `test/config.test.mjs` specifically.

## Style

- ESM, two-space indent, single quotes, semicolons.
- Comments explain *why* a rule exists, not what the next line does.
- Errors carry a machine-readable `code` (`REMOTE_PATH_OUTSIDE_ROOT`,
  `SSH2_MISSING`, …) and a sentence a person can act on.
- Tool descriptions are prompt surface: say what the tool does, what it refuses,
  and what to call next.

## Documentation

`README.md` and `README.zh-CN.md` are kept in step — a change to one is a change
to both. Architecture decisions belong in `docs/architecture.md`, behaviour
changes in `CHANGELOG.md` under `## [Unreleased]`.

## Security

Read [`SECURITY.md`](./SECURITY.md) before touching connection handling, path
resolution or the panel API. Do not paste real hostnames, keys or passwords into
issues, tests or fixtures.
