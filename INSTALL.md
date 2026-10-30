# Install dsh-remote-ctx

This file is written for an agent that has been asked to install the plugin.
Follow it in order; stop and report the exact error if a step fails.

## 1. Check the host

The plugin runs inside DeepSeek Harness, not beside it. Confirm:

```bash
dsh --version          # must be >= 0.2.1-rc.1
node --version         # must be >= 22.13
```

If `dsh` is not on `PATH`, the harness is installed but not linked; use the
desktop app's **Plugins → Add plugin** dialog instead of the CLI.

## 2. Install for the right profile

`web` is the profile behind `dsh web`:

```bash
dsh plugin --profile web add github:Roshenn/dsh-remote-ctx
```

Alternatives, in order of preference:

```bash
# local checkout
dsh plugin --profile web add /absolute/path/to/dsh-remote-ctx

# published release
dsh plugin --profile web add dsh-remote-ctx@0.1.0
```

The command forwards to pnpm against the profile's `package.json`; the package's
`dsh.bundle.patch` mounts `cordis.patch.yml`, which inserts the `remote-ctx`
row. `ssh2` is the only runtime dependency and it needs no build step.

Do **not** install into the `desktop` profile from the CLI — the desktop shell
manages it. Use **Plugins → Add plugin** there.

## 3. Restart

Fully stop and start the harness (tray → Quit, then relaunch; or restart
`dsh web`). A page refresh alone does not load new plugin code.

## 4. Verify

```bash
dsh --profile web --dump-config | grep remote-ctx
```

Expected: a row with `id: remote-ctx` and `name: 'dsh-remote-ctx'`.

Package-level sanity check (works from a checkout):

```bash
node scripts/check.mjs    # package manifest, patch file, exports
node scripts/smoke.mjs    # resolved config + connection count
```

In the running UI, the sidebar should now show **Remote context**. Opening it
with no connections is the expected first-run state.

## 5. First connection

In the panel: **Add connection** → host, port, username, auth (agent / key file /
password), and the **remote root** (the directory that becomes the workspace).
Press **Test**.

Or ask the model:

> Call remote_ctx_connections with action "add": host 192.168.1.20, username
> builder, key ~/.ssh/id_ed25519, remoteRoot /srv/workspaces/app.

Then:

> Call remote_ctx_index for that connection and tell me how many files it found.

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Tools never appear | profile not restarted, or wrong profile | restart; check `--dump-config` |
| `SSH2_MISSING` | dependencies were skipped by the installer | reinstall, or `pnpm add ssh2` in the profile |
| `SSH_CONNECT_FAILED` | host/port/credentials/Firewall | test with `ssh user@host` from the same machine |
| `SSH_SFTP_UNAVAILABLE` | target disabled the SFTP subsystem | enable `Subsystem sftp` in `sshd_config` |
| `REMOTE_PATH_OUTSIDE_ROOT` | path escaped `remoteRoot` | use a path inside the configured root |
| `SSH_AGENT_MISSING` | agent auth with no socket | set `auth.agent`, `SSH_AUTH_SOCK`, or switch to a key |

## 7. Uninstall

```bash
dsh plugin --profile web remove dsh-remote-ctx
```

Connection records and index caches stay under `$DSH_HOME/remote-ctx/`; delete
that directory if they should go too. Nothing was installed on the target host.
