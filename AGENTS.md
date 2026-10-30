# AGENTS.md — working agreements for agents in this repo

For any agent working in this repository, including sessions running under DSH.
These rules bind this repo only; when the user's instruction for the current task
conflicts with them, the user's instruction wins.

The repo is a DSH plugin: plain ESM under `lib/`, one lazily imported runtime
dependency (`ssh2`), no build step, 69 offline tests. `CONTRIBUTING.md`,
`SECURITY.md` and `docs/architecture.md` are the source of the rules below — if
one of them changes, change this file in the same commit.

---

## 1. Commit after every change (hard rule)

**Trigger**: any change under `lib/`, `test/`, `scripts/`, `docs/`, or to
`package.json`, `cordis.patch.yml`, `README*.md`, `CHANGELOG.md`, `SECURITY.md`,
`CONTRIBUTING.md`. Once the checks below pass, **commit immediately** — do not
wait for the user to say "commit", and do not batch the turn's work into one
commit at the end.

**Granularity**: one logical change, one commit. Two separate fixes are two
commits; the files of one feature go together.

**Format**: Conventional Commits, title under 72 characters, body explains *why*:

```
<type>(<scope>): <what changed, in one line>

- what changed (files / behaviour)
- why (the problem or request that triggered it)
- verification (what you ran, what it printed)
```

`type` is limited to: `feat` / `fix` / `docs` / `refactor` / `perf` / `test` /
`build` / `chore`.
`scope` is usually one of: `host` (`lib/*.mjs`), `panel` (`lib/client.js` and the
sidebar UI), `tools` (`lib/index.js`, tool descriptions), `test`, `scripts`,
`docs`, `deps`.

**Before committing**:

1. `npm test` is green — 69 tests, under a second, no network and no
   `npm install` (the `dsh-tools` peer is stubbed by `test/stub/loader.mjs`, the
   remote side is `test/fake-remote.mjs`).
2. `npm run check` is green — the manifest, the bundle patch row, the two
   exports, `files[]`, the license, and the assertion that `lib/client.js` never
   mentions a password or `ssh2`.
3. `git status --short` — read the change list before staging.
4. **`git add` only the files you touched.** No `git add -A`, no `git add .` —
   other sessions may be working in the same checkout, and a blanket add pulls
   their half-finished edits into your commit.

A docs-only commit may skip steps 1 and 2, but the commit body must say that it
did.

**Deliberately not done**:

- **No `git push`.** `origin` is `git@github.com:Roshenn/dsh-remote-ctx.git`;
  publishing is an outward-facing act. Wait until the user asks.
- **No rewriting pushed history**: no `--amend` on a pushed commit, no force
  push.
- **No committing artifacts or secrets**: `node_modules`, `.env`, credentials,
  `*.tgz`. Connection records and stored passwords live under
  `$DSH_HOME/remote-ctx/`, never in this tree.

---

## 2. Do not use checkout/reset to clear the working tree

`git checkout -- <file>` and `git reset --hard` **destroy uncommitted work with no
recovery path**. To drop one local change: copy the file outside the repo first,
then edit. If you are unsure whether work is disposable, leave it alone and ask.

---

## 3. Repo invariants — a change that breaks one is wrong by default

These are the project's reason for existing, not preferences. A change that
crosses one needs the user's explicit agreement first.

| Invariant | Stated in | What it means for a change |
|---|---|---|
| No command execution | `CONTRIBUTING.md`, `SECURITY.md` | Only the SFTP subsystem is used. No shell, PTY, git or build on the target — that is `dsh-remote-ssh`'s job. |
| No deletion | `CONTRIBUTING.md`, `SECURITY.md` | No mirror direction deletes, and no tool removes a remote file. |
| One runtime dependency, lazily imported | `package.json` | `ssh2` is the only dependency and must stay lazily imported. A second one needs a paragraph on why the platform cannot do it. |
| No build step | `CONTRIBUTING.md` | `lib/` is plain ESM, shipped and loaded as-is. No bundler, no transpile. |
| Paths are confined before SFTP | `lib/paths.mjs` | Every remote path is normalised and proven inside `remoteRoot`; `..`, absolute escapes and prefix tricks such as `/srv/work-other` are refused. Changes here need a test in `test/paths.test.mjs`. |
| Secrets stay local | `lib/config.mjs`, `SECURITY.md` | A password is 0600 under `$DSH_HOME`, never returned by a tool, never sent to the browser. Changes here need a test in `test/config.test.mjs`. |
| READMEs stay in step | `CONTRIBUTING.md` | `README.md` and `README.zh-CN.md` change together. Architecture decisions go in `docs/architecture.md`; behaviour changes go in `CHANGELOG.md` under `## [Unreleased]`. |
| No real hosts in tests | `CONTRIBUTING.md` | No real hostnames, keys or passwords in tests, fixtures, examples or issues. |

Style, from `CONTRIBUTING.md`: ESM, two-space indent, single quotes, semicolons.
Comments explain *why* a rule exists, not what the next line does. Errors carry a
machine-readable `code` (`REMOTE_PATH_OUTSIDE_ROOT`, `SSH2_MISSING`, …) plus a
sentence a person can act on. Tool descriptions are prompt surface: say what the
tool does, what it refuses, and what to call next.

---

## 4. Self-check before committing

| What changed | Minimum check |
|---|---|
| `lib/*.mjs` (host half) | `npm test` + `npm run check`; restart DSH before checking through a live session, modules are cached after load |
| `lib/client.js` (panel) | reload the sidebar panel and click the flow you touched; `npm run check` (it greps this file) |
| `lib/index.js` (tool surface) | the tests in `test/plugin.test.mjs`, plus `npm run smoke` to print the resolved config and tool list |
| `lib/ssh2-adapter.mjs` | tests only prove the adapter shape — it is exercised in-memory; say so in the commit body if the change is untested against a real SSH server |
| `test/` | run the suite; a behaviour fix must come with a test that fails without the fix |
| `scripts/` | run that script directly |
| docs only | read it once; tests optional, note the skip in the commit body |

`npm run smoke` prints the resolved `$DSH_HOME` paths, read cap, write switch and
the tool list without opening a connection — run it after touching config or the
plugin contract.

---

## 5. Commit examples

```bash
git add lib/paths.mjs test/paths.test.mjs
git commit -m "fix(host): refuse a sibling root that shares remoteRoot's prefix

- resolve() compared strings, so /srv/work-other passed as /srv/work
- compare on a separator-terminated prefix instead
- verification: npm test (69 pass, new case fails without the fix)"

git add lib/mirror.mjs test/mirror.test.mjs CHANGELOG.md
git commit -m "feat(host): report per-file failures in mirror rows

- one unreadable file aborted the whole push
- rows now carry ok/error, the plan continues past a failure
- verification: npm test + npm run check green"
```

---

## 6. When in doubt

Read `docs/architecture.md` before moving a boundary, `SECURITY.md` before
touching connection handling, path resolution or the panel API, and
`CONTRIBUTING.md` before adding a dependency or a bigger surface. If a rule here
looks wrong for the task at hand, say so instead of working around it.
