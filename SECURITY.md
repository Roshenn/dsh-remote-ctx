# Security policy

This plugin opens SSH connections and writes files on a remote host. Both are
security-relevant, so the boundaries are stated here as a contract.

## Reporting a vulnerability

Open a private report through GitHub's **Security → Report a vulnerability** on
[Roshenn/dsh-remote-ctx](https://github.com/Roshenn/dsh-remote-ctx/security) if
the issue is exploitable. For anything else, a normal issue is fine.

Please include: the version, the tool or API route involved, the connection
shape (auth kind, `remoteRoot`), and the smallest reproduction you have.

## Threat model

**Trusted:** the local machine, `$DSH_HOME`, the model's instructions, the SSH
target itself.

**Untrusted:** paths and arguments produced by the model or the browser. They
are confined before they reach SFTP (`lib/paths.mjs`), and the panel re-validates
every connection id and path.

## What the plugin guarantees

- **Path confinement.** Every remote path is normalised and proven to sit inside
  the connection's `remoteRoot`; `..`, absolute escapes and prefix tricks such as
  `/srv/work-other` are refused. Tests cover each case.
- **Atomic writes.** Remote writes go to a temporary name and are renamed into
  place; a failed write leaves the previous file untouched.
- **No deletion.** Neither mirror direction deletes anything, and no tool can
  remove a remote file.
- **Secrets stay local.** A password is stored under `$DSH_HOME/remote-ctx/`
  with mode 0600, is never returned by a tool, and is never sent to the browser
  (the panel sees `hasPassword: true`).
- **No shell on the target.** Only the SFTP subsystem is used. There is no
  remote helper, no daemon and no command execution.

## What it does not guarantee

- **Host-key verification is opt-in.** Without `hostFingerprint`, `ssh2` accepts
  any host key. Pin the fingerprint for anything beyond a trusted LAN.
- **The remote root is a path, not a sandbox.** A server that resolves symlinks
  can point a path outside the root; the plugin confines the path string, not
  the target's filesystem semantics. Read-only keys or a restricted sftp
  subsystem are the server-side answer.
- **`allowRemoteWrite: false` is a switch, not a permission system.** It stops
  this plugin's writes; it cannot stop a model that has other tools.
- **Credentials in plugin config.** Putting a password in `cordis.patch.yml`
  copies it into the profile config. Prefer key or agent auth there.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes (current) |
