<div align="center">

# dsh-remote-ctx

**Put a workspace's files on a remote host over plain SSH — then list, read, write, link and index them like local files. Agents, sessions and `$DSH_HOME` stay on your machine.**

[简体中文](./README.zh-CN.md) · [Install](#install) · [Quick start](#quick-start) · [Security](./SECURITY.md) · [Architecture](./docs/architecture.md) · [Changelog](./CHANGELOG.md)

[![npm version](https://img.shields.io/npm/v/dsh-remote-ctx?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-remote-ctx)
[![npm downloads](https://img.shields.io/npm/dm/dsh-remote-ctx?style=flat-square&color=cb3837)](https://www.npmjs.com/package/dsh-remote-ctx)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.1-4B32C3?style=flat-square)](#compatibility)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square&logo=node.js&logoColor=white)](#compatibility)
[![tests](https://img.shields.io/badge/tests-53%20passing-brightgreen?style=flat-square)](./test)

</div>

`dsh-remote-ctx` is a DeepSeek Harness plugin for the smallest possible remote
setup: **an SSH login and nothing else**. The target needs no DSH install, no
CLI, no helper binary and no daemon — the OpenSSH server's SFTP subsystem is the
entire contract. The workspace's files are read, written, linked and indexed
through that channel, so the model can work on a remote tree exactly the way it
works on a local one, while the agent, the sessions and all workspace metadata
stay on this machine.

If you have ever wanted "the files are over there, but the agent is here", this
is that plugin.

---

## Why

DSH normally assumes the workspace is on local disk. A remote machine — a build
box, a home server, a laptop on the LAN — is therefore out of reach unless you
install and run something on it, or copy the tree back and forth.

This plugin takes the narrowest useful slice of that problem:

| Need | How `dsh-remote-ctx` answers it |
| --- | --- |
| Files live on another host | SFTP over the SSH connection you already have |
| The model should treat them like local files | `remote_ctx_*` tools with the same path semantics, plus a cached local index for search |
| The workspace should get there easily | one `remote_ctx_sync` push from the local workspace, SFTP only |
| Nothing new installed on the target | no CLI, no daemon, no agent, no DSH on the remote |
| Agent, sessions, history stay here | they do; only file bytes cross the wire |

## What it is, and what it is not

**It is** a remote *context* bridge: files, listings, search, a small mirror, and
a sidebar panel to drive them.

**It is not** a remote shell. Commands do not run on the target, there is no PTY,
no git execution and no build. When you need those, use
[`dsh-remote-ssh`](https://github.com/Roshenn/dsh-remote-ssh), which replaces
`ctx.fs` / `ctx.subprocess` and runs commands remotely. The two plugins can be
installed side by side.

## Features

- **SSH-only target.** SFTP is part of every OpenSSH install; nothing else is
  required on the other side.
- **Your `~/.ssh/config` is the source.** The panel lists every concrete `Host`
  with its hostname, user, port and key; picking one fills the connection form —
  nothing you already configured has to be retyped.
- **Path confinement by construction.** Every remote path is normalised and
  proven inside the connection's `remoteRoot` before it reaches SFTP — model
  arguments and HTTP bodies included.
- **Local index, remote tree.** The remote tree is walked once and cached under
  `$DSH_HOME/remote-ctx/index/`; search then runs locally, with content grep
  going back over the wire only for plausible text files.
- **Atomic writes.** Write to a temporary name, rename into place; a failed
  write never leaves a half-written file.
- **A mirror that cannot delete.** Push local → remote or pull remote → local;
  size-based comparison, `force` when you mean it, `dryRun` before you do.
- **Lazy connections.** One pooled SFTP session per connection, keepalive,
  closed after an idle TTL — no SSH client is built until a tool needs one.
- **Secrets stay local.** Passwords live 0600 under `$DSH_HOME` and are never
  returned by a tool or sent to the browser.
- **Zero build, zero runtime glue.** Plain ESM; `ssh2` is the only dependency and
  it is imported lazily.

## Tools

| Tool | What it does | Key arguments |
| --- | --- | --- |
| `remote_ctx_connections` | List / add / update / remove / test / discover / import SSH connections | `action`, `id`, `host?`, `port?`, `username?`, `privateKeyPath?`, `password?`, `agentSocket?`, `remoteRoot?`, `localWorkspace?` |
| `remote_ctx_ls` | List one remote directory: type, size, mtime | `connection`, `path?`, `limit?` |
| `remote_ctx_read` | Read a remote text file, bounded and truncation-aware | `connection`, `path`, `limit?` |
| `remote_ctx_write` | Atomic write inside the remote root | `connection`, `path`, `content` |
| `remote_ctx_index` | Walk the remote root and cache the file index locally | `connection`, `refresh?`, `maxDepth?`, `maxFiles?` |
| `remote_ctx_find` | Search the index by path, name, glob or content | `connection`, `query`, `mode?`, `type?`, `limit?`, `refresh?` |
| `remote_ctx_sync` | Mirror the local workspace to the remote, or back | `connection`, `direction?`, `localRoot?`, `path?`, `dryRun?`, `force?` |

`connection` may be omitted when exactly one connection is configured.

## Install

Requires Node.js `>= 22.13`, DSH `>= 0.2.1-rc.1`, and an SSH account on the
target with the SFTP subsystem enabled.

```bash
# from this repository (available now)
dsh plugin --profile web add github:Roshenn/dsh-remote-ctx

# from a local checkout
dsh plugin --profile web add ./dsh-remote-ctx

# from npm, once the release lands
npx -y @deepseek-ai/dsh plugin --profile web add dsh-remote-ctx@0.1.0
```

Then restart `dsh web` (a page refresh alone does not load new plugin code).

Verify the row landed:

```bash
dsh --profile web --dump-config | grep remote-ctx
```

**Desktop app:** the `desktop` profile is managed by the shell, so open
**Plugins → Add plugin** and enter the same package reference instead of using
the CLI.

**Target side:** nothing to install. Confirm SFTP is available if you are unsure:

```bash
ssh you@host 'echo $SHELL; ls -d ~'
```

### Let your agent install it

> Read INSTALL.md at https://github.com/Roshenn/dsh-remote-ctx and follow it.
> Then run the smoke check and tell me the result.

### Local development (linked checkout)

`dsh plugin` cannot manage the `desktop` profile, and while developing you want
the running app to load the checkout on disk rather than a published copy. The
dev install is therefore the same shape `dsh-looptree-dashboard` uses: a `link:`
dependency plus a bundle entry in the profile manifest. One command makes both
edits, idempotently:

```bash
node scripts/dev-link.mjs --profile "$DSH_HOME/profiles/desktop"
```

Then install twice — once in the profile, once in this checkout:

```bash
cd "$DSH_HOME/profiles/desktop" && pnpm install --prefer-offline
cd /path/to/dsh-remote-ctx && npm install --no-package-lock
```

The second install is not optional: **a linked checkout keeps its own
`node_modules`**, so the profile install never installs `ssh2` for this package.
Without it the plugin loads, every tool works, and every connection attempt fails
with `SSH2_MISSING`.

Fully quit and relaunch DeepSeek Harness — a page reload does not load new plugin
code. The sidebar should then show **Remote context**.

`--dry-run` prints the manifest that would be written, `--remove` undoes both
edits, and `--install` runs the profile `pnpm install` for you.

| File | Change |
| --- | --- |
| `profiles/desktop/package.json` | `"dsh-remote-ctx": "link:../../dsh-remote-ctx"` |
| `profiles/desktop/package.json` | append `dsh-remote-ctx` to `dsh.profile.bundles` |

## Quick start

1. Open the sidebar entry **Remote context**. The page is a two-column
   workbench: **SSH 配置** on the left lists every concrete `Host` from
   `~/.ssh/config`, and the **新建连接** form is already open on the right.
   Clicking a host only prefills that form — nothing is saved until **连接** is
   pressed.
2. Press **Test** — a successful test reports the remote home and root.
3. Press **Browse** to walk the remote tree, then **Index here** to cache it.
4. Ask in chat: *"What files are in the remote workspace? Find the config that
   mentions DATABASE_URL."*
5. To copy the current local workspace over, press **Mirror** with `dry run`
   ticked first, then run it for real.

A typical agent session:

```
> Connect to the workspace on the LAN box and find where the retry budget is set.

  remote_ctx_connections  action=list
  remote_ctx_index        connection=lan
  remote_ctx_find         connection=lan query="retry" mode=content
  remote_ctx_read         connection=lan path=src/config/retry.ts
```

## Configuration

Defaults live in [`cordis.patch.yml`](./cordis.patch.yml). The patch loader
replaces a row's whole `config` object — restate every field you need.

| Field | Default | Meaning |
| --- | --- | --- |
| `connectionsFile` | `$DSH_HOME/remote-ctx/connections.json` | Where connection records live (written 0600) |
| `indexDir` | `$DSH_HOME/remote-ctx/index` | Where built file indexes are cached |
| `connectTimeoutMs` | `15000` | Budget for opening the SSH connection |
| `keepaliveIntervalMs` | `15000` | Idle connection probe interval |
| `idleTtlMs` | `180000` | Idle TTL before a pooled connection is closed |
| `maxIndexFiles` | `20000` | Hard cap on one walk |
| `maxIndexDepth` | `8` | Hard cap on walk depth |
| `maxReadBytes` | `262144` | Default read budget per file |
| `sshConfigFile` | `~/.ssh/config` | Where the left rail reads `Host` entries from |
| `allowRemoteWrite` | `true` | Set `false` for a read-only install |

Connections can also come from a hand-written file. The flat shape is compatible
with `$DSH_HOME/dsh-ssh-connections.json`:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "lan",
      "label": "LAN build box",
      "host": "192.168.1.20",
      "port": 22,
      "username": "builder",
      "auth": { "kind": "key", "privateKeyPath": "~/.ssh/id_ed25519" },
      "remoteRoot": "/srv/workspaces/app",
      "localWorkspace": "/home/me/app"
    }
  ]
}
```

## How it works

```
 local machine                                 remote host
┌──────────────────────────────┐              ┌──────────────────────────┐
│  dsh web + agent + sessions  │              │  sshd                    │
│  ┌────────────────────────┐  │    SSH       │  └─ sftp subsystem       │
│  │ dsh-remote-ctx (host)  │──┼─────────────▶│      └─ the workspace    │
│  │  · path confinement    │  │  (SFTP only) │         tree             │
│  │  · index cache (local) │◀─┼──────────────│                          │
│  │  · mirror planner      │  │              │  no CLI, no daemon,      │
│  └────────────────────────┘  │              │  no DSH, no agent        │
│  $DSH_HOME/remote-ctx/       │              └──────────────────────────┘
└──────────────────────────────┘
```

The host half wires seven tools over the `tools` service and, when a web server
exists, mounts one prefix route (`/remote-ctx`) for the panel. A pooled
`RemoteFs` per connection owns the SFTP channel; everything above it — walker,
indexer, mirror, tools, HTTP — is transport-agnostic, which is why the test suite
runs the whole stack against an in-memory adapter with no network at all.
Details in [`docs/architecture.md`](./docs/architecture.md).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SSH_AUTH_FAILED` — server rejected every method | the imported key is not in `authorized_keys`, the password is wrong, or the account may not log in | run the same `ssh user@host` from a terminal: if it fails too, fix the server (`ssh-copy-id`) or edit the connection and switch to password |
| `SSH_KEY_UNREADABLE` — key not found / passphrase | the key path is on **this** machine; an encrypted key needs its passphrase | correct the path, or fill 密钥口令 in the edit form |
| `SSH_AGENT_MISSING` | agent auth needs `SSH_AUTH_SOCK`; Windows OpenSSH agent is a named pipe ssh2 cannot open | use key or password auth |
| `SSH_SFTP_UNAVAILABLE` | the server closed the SFTP subsystem | enable `Subsystem sftp` in `sshd_config` |
| timeout on a LAN host | wrong network, or the VPN is down | check `ssh user@host` from the same machine |

To see what a server allows: `ssh -v user@host true` prints
`Authentications that can continue: …`. The plugin never guesses: it tries the
method stored on the connection and reports exactly what was refused.
## Safety boundaries

- **Host keys:** without a pinned `hostFingerprint`, `ssh2` accepts any host key.
  Pin it for anything outside a trusted LAN.
- **Remote root is a path contract, not a server-side sandbox.** The plugin
  refuses paths that escape the root; it cannot override how the target resolves
  symlinks. Use a restricted key or a chrooted SFTP subsystem when that matters.
- **No deletion, ever.** Both mirror directions only add or overwrite.
- **Up-to-date means "same size".** Content hashes are not part of v0.1 — use
  `force` when a same-size edit must be transferred.
- **Approvals do not sandbox plugin code.** A plugin runs with your permissions;
  only install ones you trust.

Full policy and reporting process: [`SECURITY.md`](./SECURITY.md).

## Compatibility

| | |
| --- | --- |
| DSH | `>= 0.2.1-rc.1` |
| Node.js | `>= 22.13` |
| Platforms | Windows, macOS, Linux (wherever `ssh2` runs) |
| Target | any SSH server with the SFTP subsystem (OpenSSH default) |
| Host kind | tools + browser panel (`dsh.client.platform: web`) |
| Runtime deps | `ssh2 ^1.17` (imported lazily) |

## Design references

The project follows the conventions of the plugins that shaped the DSH
ecosystem, and says so:

| Reference | What was borrowed |
| --- | --- |
| [liustack/modsearch](https://github.com/liustack/modsearch) | README shape: tagline → badges → features → install matrix → docs table → license; bilingual README pair; agent-facing `INSTALL.md` |
| [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | Badge style and demo-before-features ordering; collapsible compatibility matrix; explicit security and limitations section |
| [liustack/modlens](https://github.com/liustack/modlens) | `dsh.bundle.patch` as a patch layer mounted from `package.json`, rather than a bespoke installer |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `docs/` layout, an explicit "supported DSH versions" statement, and a data-and-trust section |
| [regrevia/dsh-unlag](https://github.com/regrevia/dsh-unlag) | Single-package host + client bundle: `exports["./client"]` plus `dsh.client` in one `package.json` |
| [Roshenn/dsh-workaround-git](https://github.com/Roshenn/dsh-workaround-git) | The local sibling convention: `defineTool` output contract, `plan → apply` batches where a failure is a row, not a throw |

## Status

`0.1.0` — the host half, the panel, the index and the mirror are implemented and
covered by 53 tests. What is deliberately missing:

- remote command execution / PTY (use `dsh-remote-ssh`);
- deletion in the mirror;
- content-hash based change detection;
- per-file progress streaming in the panel.

## Development

```bash
node --test "test/*.test.mjs"   # 53 tests, no dependencies, no network
node scripts/check.mjs          # package manifest / patch / export sanity
node scripts/smoke.mjs          # print the resolved config and connections
```

`@deepseek-ai/dsh-tools` is a peer dependency supplied by the harness; the tests
swap in a contract stub through a Node loader hook and pass an in-memory SFTP
adapter, so a checkout needs no `npm install` to be verified.

## License

[MIT](./LICENSE) © 2026 jrri (Roshenn)
