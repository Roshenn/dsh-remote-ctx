/**
 * dsh-remote-ctx — browser half.
 *
 * One left-sidebar entry plus its main-area page. It talks to the host half over
 * `/remote-ctx/api` (same origin): connection records, remote directory
 * browsing, index status, and the mirror (push/pull) run. No SSH code, no
 * secrets, no connection strings are built here.
 *
 * Loaded through the same ModuleLoader contract as the other client plugins in
 * the profile: `window.__ModuleLoader__.load({ id, factory })` returning
 * `{ name, inject, apply }`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-ctx',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const API = '/remote-ctx/api';
    const PANEL_ID = 'remote-ctx';
    const PANEL_LABEL = 'Remote context';

    const CSS = `
      .rc-root { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--rc-fg); background: var(--rc-bg); }
      .rc-root *, .rc-root *::before, .rc-root *::after { box-sizing: border-box; }
      .rc-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 14px 20px;
        border-bottom: 1px solid var(--rc-line); }
      .rc-title { font-size: 15px; font-weight: 600; margin: 0; }
      .rc-grow { flex: 1 1 auto; }
      .rc-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px 20px 40px; }
      .rc-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--rc-line);
        background: var(--rc-card); color: var(--rc-fg); font-size: 12px; cursor: pointer; }
      .rc-btn:hover:not(:disabled) { border-color: var(--rc-accent); }
      .rc-btn:disabled { opacity: .45; cursor: default; }
      .rc-btn-primary { background: var(--rc-accent); border-color: var(--rc-accent); color: #fff; }
      .rc-card { border: 1px solid var(--rc-line); border-radius: 10px; background: var(--rc-card); }
      .rc-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
      .rc-row + .rc-row { border-top: 1px solid var(--rc-line); }
      .rc-name { font-weight: 600; font-size: 13px; }
      .rc-muted { color: var(--rc-muted); }
      .rc-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; word-break: break-all; }
      .rc-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px;
        border: 1px solid var(--rc-line); font-size: 11px; color: var(--rc-muted); white-space: nowrap; }
      .rc-badge-ok { color: var(--rc-ok); border-color: color-mix(in srgb, var(--rc-ok) 40%, transparent); }
      .rc-badge-err { color: var(--rc-danger); border-color: color-mix(in srgb, var(--rc-danger) 40%, transparent); }
      .rc-form { display: grid; grid-template-columns: 150px 1fr; gap: 10px 14px; align-items: center;
        padding: 16px 18px; border: 1px solid var(--rc-line); border-radius: 10px; background: var(--rc-card); }
      .rc-form label { font-size: 12px; color: var(--rc-muted); }
      .rc-input, .rc-select { height: 30px; width: 100%; padding: 0 9px; border-radius: 7px; border: 1px solid var(--rc-line);
        background: var(--rc-bg); color: var(--rc-fg); font: 12.5px/1.5 inherit; }
      .rc-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .rc-list { margin: 0; padding: 0; list-style: none; }
      .rc-entry { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-radius: 6px; cursor: default; }
      .rc-entry-dir { cursor: pointer; }
      .rc-entry-dir:hover { background: color-mix(in srgb, var(--rc-accent) 10%, transparent); }
      .rc-kind { flex: 0 0 34px; font-size: 11px; color: var(--rc-muted); }
      .rc-ename { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
      .rc-esize { flex: 0 0 70px; text-align: right; font-size: 11px; color: var(--rc-muted); }
      .rc-crumb { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      .rc-error { margin: 10px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px;
        color: var(--rc-danger); border: 1px solid color-mix(in srgb, var(--rc-danger) 35%, transparent); }
      .rc-ok { margin: 10px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px;
        color: var(--rc-ok); border: 1px solid color-mix(in srgb, var(--rc-ok) 35%, transparent); }
      .rc-pre { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--rc-line);
        background: var(--rc-bg); font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space: pre-wrap; max-height: 260px; overflow: auto; }
      .rc-empty { padding: 44px 0; text-align: center; color: var(--rc-muted); }
      :root { --rc-bg: #ffffff; --rc-card: #ffffff; --rc-fg: #1f2328; --rc-muted: #6b7280; --rc-line: #e5e7eb;
        --rc-accent: #3b82f6; --rc-ok: #15803d; --rc-danger: #b91c1c; }
      [data-theme="dark"] { --rc-bg: #17181a; --rc-card: #1e1f22; --rc-fg: #e6e7e9; --rc-muted: #9aa0a6;
        --rc-line: #2c2e33; --rc-accent: #5b9cff; --rc-ok: #4ade80; --rc-danger: #f87171; }
    `;

    function injectStyle() {
      if (document.getElementById('dsh-remote-ctx-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-remote-ctx-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!body.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      return body.data;
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }

    const Field = ({ label, children }) => h('label', null, label);
    const Input = (props) => h('input', { className: 'rc-input', ...props });

    function Section({ title, action, children }) {
      return h('section', { style: { marginBottom: 20 } },
        h('div', { className: 'rc-actions', style: { marginBottom: 10 } },
          h('h2', { style: { fontSize: 13, margin: 0, fontWeight: 600 } }, title),
          h('span', { className: 'rc-grow' }),
          action ?? null),
        children);
    }

    function ConnectionForm({ initial, onSubmit, onCancel, busy }) {
      const [form, setForm] = useState(() => ({
        id: initial?.id ?? '',
        label: initial?.label ?? '',
        host: initial?.host ?? '',
        port: initial?.port ?? 22,
        username: initial?.username ?? '',
        remoteRoot: initial?.remoteRoot ?? '~',
        localWorkspace: initial?.localWorkspace ?? '',
        authKind: initial?.auth?.kind ?? 'agent',
        privateKeyPath: initial?.auth?.privateKeyPath ?? '',
        password: '',
        agent: initial?.auth?.agent ?? '',
        hostFingerprint: initial?.hostFingerprint ?? '',
      }));
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
      const submit = (event) => {
        event.preventDefault();
        const connection = {
          id: form.id.trim() || undefined,
          label: form.label.trim() || form.host.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim() || undefined,
          remoteRoot: form.remoteRoot.trim() || '~',
          localWorkspace: form.localWorkspace.trim() || undefined,
          hostFingerprint: form.hostFingerprint.trim() || undefined,
          auth: form.authKind === 'key'
            ? { kind: 'key', privateKeyPath: form.privateKeyPath.trim() }
            : form.authKind === 'password'
              ? { kind: 'password', ...(form.password ? { password: form.password } : {}) }
              : { kind: 'agent', ...(form.agent.trim() ? { agent: form.agent.trim() } : {}) },
        };
        onSubmit(connection);
      };
      return h('form', { className: 'rc-form', onSubmit: submit },
        h(Field, null, 'id'),
        h(Input, { value: form.id, onChange: set('id'), placeholder: 'auto from label' }),
        h(Field, null, 'label'),
        h(Input, { value: form.label, onChange: set('label'), placeholder: 'lecoo-lan' }),
        h(Field, null, 'host'),
        h(Input, { value: form.host, onChange: set('host'), placeholder: '192.168.1.20', required: true }),
        h(Field, null, 'port'),
        h(Input, { value: form.port, onChange: set('port'), type: 'number' }),
        h(Field, null, 'username'),
        h(Input, { value: form.username, onChange: set('username'), placeholder: 'jerome' }),
        h(Field, null, 'auth'),
        h('select', { className: 'rc-select', value: form.authKind, onChange: set('authKind') },
          h('option', { value: 'agent' }, 'ssh-agent'),
          h('option', { value: 'key' }, 'private key'),
          h('option', { value: 'password' }, 'password')),
        form.authKind === 'key' ? h(Field, null, 'key path') : null,
        form.authKind === 'key'
          ? h(Input, { value: form.privateKeyPath, onChange: set('privateKeyPath'), placeholder: '~/.ssh/id_ed25519' })
          : null,
        form.authKind === 'password' ? h(Field, null, 'password') : null,
        form.authKind === 'password'
          ? h(Input, { value: form.password, onChange: set('password'), type: 'password', placeholder: initial?.auth?.hasPassword ? 'unchanged' : '' })
          : null,
        form.authKind === 'agent' ? h(Field, null, 'agent socket') : null,
        form.authKind === 'agent'
          ? h(Input, { value: form.agent, onChange: set('agent'), placeholder: '$SSH_AUTH_SOCK' })
          : null,
        h(Field, null, 'remote root'),
        h(Input, { value: form.remoteRoot, onChange: set('remoteRoot'), placeholder: '/srv/workspace or ~/workspace' }),
        h(Field, null, 'local workspace'),
        h(Input, { value: form.localWorkspace, onChange: set('localWorkspace'), placeholder: 'C:\\\\work\\\\my-project' }),
        h(Field, null, 'host key'),
        h(Input, { value: form.hostFingerprint, onChange: set('hostFingerprint'), placeholder: 'SHA256:… (optional)' }),
        h('span', null),
        h('div', { className: 'rc-actions' },
          h('button', { className: 'rc-btn rc-btn-primary', type: 'submit', disabled: busy }, busy ? 'Saving…' : 'Save connection'),
          h('button', { className: 'rc-btn', type: 'button', onClick: onCancel, disabled: busy }, 'Cancel')));
    }

    function Browse({ connectionId, root, onClose }) {
      const [path, setPath] = useState(root);
      const [listing, setListing] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');

      const load = (target) => {
        setBusy(true);
        setError('');
        api(`/browse?id=${encodeURIComponent(connectionId)}&path=${encodeURIComponent(target ?? '')}`)
          .then((data) => {
            setListing(data);
            setPath(data.path);
          })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(false));
      };
      useEffect(() => { load(root); }, [connectionId]);

      const index = () => {
        setBusy(true);
        setNote('');
        setError('');
        api('/index', { method: 'POST', body: { id: connectionId } })
          .then((data) => setNote(`indexed ${data.summary.files} files, ${data.summary.dirs} dirs`))
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(false));
      };

      const parent = listing?.path && listing.path !== listing.root
        ? listing.path.slice(0, Math.max(listing.path.lastIndexOf('/'), 1))
        : undefined;

      return h('div', null,
        h('div', { className: 'rc-crumb' },
          h('button', { className: 'rc-btn', onClick: () => load(), disabled: busy }, 'Root'),
          parent ? h('button', { className: 'rc-btn', onClick: () => load(parent), disabled: busy }, 'Up') : null,
          h('span', { className: 'rc-mono rc-muted' }, listing?.path ?? path),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-btn', onClick: index, disabled: busy || !listing }, 'Index here'),
          h('button', { className: 'rc-btn', onClick: onClose }, 'Done')),
        error ? h('div', { className: 'rc-error' }, error) : null,
        note ? h('div', { className: 'rc-ok' }, note) : null,
        !listing && busy ? h('div', { className: 'rc-empty' }, 'Listing…') : null,
        listing
          ? h('div', { className: 'rc-card' },
            h('ul', { className: 'rc-list' },
              listing.entries.map((entry) => h('li', {
                key: entry.name,
                className: `rc-entry${entry.type === 'dir' ? ' rc-entry-dir' : ''}`,
                onClick: entry.type === 'dir' ? () => load(`${listing.path}/${entry.name}`) : undefined,
              },
              h('span', { className: 'rc-kind' }, entry.type === 'dir' ? 'dir' : entry.type === 'link' ? 'link' : 'file'),
              h('span', { className: 'rc-ename' }, entry.name),
              h('span', { className: 'rc-esize' }, entry.type === 'file' ? formatBytes(entry.size) : '')))))
          : null);
    }

    function SyncPanel({ connection, onDone }) {
      const [direction, setDirection] = useState('push');
      const [localRoot, setLocalRoot] = useState(connection.localWorkspace ?? '');
      const [dryRun, setDryRun] = useState(true);
      const [force, setForce] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [result, setResult] = useState('');

      const run = () => {
        setBusy(true);
        setError('');
        setResult('');
        api('/sync', { method: 'POST', body: { id: connection.id, direction, localRoot, dryRun, force } })
          .then((data) => setResult(data.text))
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(false));
      };

      return h(Section, { title: `Mirror · ${connection.label}`, action: h('button', { className: 'rc-btn', onClick: onDone }, 'Back') },
        h('div', { className: 'rc-form' },
          h(Field, null, 'direction'),
          h('select', { className: 'rc-select', value: direction, onChange: (event) => setDirection(event.target.value) },
            h('option', { value: 'push' }, 'push — local → remote'),
            h('option', { value: 'pull' }, 'pull — remote → local')),
          h(Field, null, 'local root'),
          h(Input, { value: localRoot, onChange: (event) => setLocalRoot(event.target.value), placeholder: 'absolute path to the local workspace' }),
          h(Field, null, 'dry run'),
          h('label', { style: { fontSize: 12 } },
            h('input', { type: 'checkbox', checked: dryRun, onChange: (event) => setDryRun(event.target.checked) }),
            ' plan only, write nothing'),
          h(Field, null, 'force'),
          h('label', { style: { fontSize: 12 } },
            h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
            ' also transfer files whose sizes already match'),
          h('span', null),
          h('button', { className: 'rc-btn rc-btn-primary', onClick: run, disabled: busy || !localRoot }, busy ? 'Working…' : 'Run')),
        error ? h('div', { className: 'rc-error' }, error) : null,
        result ? h('pre', { className: 'rc-pre' }, result) : null);
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null); // null | {} (add) | connection
      const [browsing, setBrowsing] = useState(null);
      const [syncing, setSyncing] = useState(null);
      const [notice, setNotice] = useState('');
      const [discovered, setDiscovered] = useState(null);

      const reload = () => {
        setBusy(true);
        // The SSH config is a convenience: a host without one still gets a panel.
        Promise.all([api('/state'), api('/ssh-config').catch(() => null)])
          .then(([data, ssh]) => { setState(data); setDiscovered(ssh); setError(''); })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(false));
      };
      useEffect(() => { reload(); }, []);

      const action = (promise) => {
        setBusy(true);
        setError('');
        setNotice('');
        return promise
          .then((data) => { setNotice('done'); return data; })
          .catch((cause) => setError(cause.message))
          .finally(() => { setBusy(false); reload(); });
      };

      const test = (id) => action(api('/test', { method: 'POST', body: { id } }))
        .then((data) => setNotice(`reachable · ${data.home} (${data.entries} entries)`));
      const remove = (id) => action(api(`/connections?id=${encodeURIComponent(id)}`, { method: 'DELETE' }));
      const importHost = (alias) => action(api('/ssh-config/import', { method: 'POST', body: { alias } }))
        .then(() => setNotice(`imported ${alias}`));
      const save = (connection) => action(api('/connections', { method: 'POST', body: { connection } }))
        .then(() => setEditing(null));

      if (browsing) {
        return h('div', { className: 'rc-root' },
          h('header', { className: 'rc-head' }, h('h1', { className: 'rc-title' }, 'Remote context')),
          h('div', { className: 'rc-body' },
            h(Browse, { connectionId: browsing.id, root: browsing.remoteRoot, onClose: () => { setBrowsing(null); reload(); } })));
      }
      if (syncing) {
        return h('div', { className: 'rc-root' },
          h('header', { className: 'rc-head' }, h('h1', { className: 'rc-title' }, 'Remote context')),
          h('div', { className: 'rc-body' }, h(SyncPanel, { connection: syncing, onDone: () => { setSyncing(null); reload(); } })));
      }

      const connections = state?.connections ?? [];
      return h('div', { className: 'rc-root' },
        h('header', { className: 'rc-head' },
          h('h1', { className: 'rc-title' }, 'Remote context'),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-btn', onClick: reload, disabled: busy }, busy ? 'Refreshing…' : 'Refresh'),
          h('button', { className: 'rc-btn rc-btn-primary', onClick: () => setEditing({}), disabled: busy }, 'Add connection')),
        h('div', { className: 'rc-body' },
          error ? h('div', { className: 'rc-error' }, error) : null,
          notice ? h('div', { className: 'rc-ok' }, notice) : null,
          editing
            ? h(Section, { title: editing.id ? `Edit ${editing.label ?? editing.id}` : 'New connection', action: h('button', { className: 'rc-btn', onClick: () => setEditing(null) }, 'Cancel') },
              h(ConnectionForm, { initial: editing.id ? editing : undefined, onSubmit: save, onCancel: () => setEditing(null), busy }))
            : null,
          discovered && discovered.entries && discovered.entries.length > 0
            ? h(Section, {
              title: 'From ~/.ssh/config',
              action: h('span', { className: 'rc-mono rc-muted', style: { fontSize: 11 } }, discovered.path ?? ''),
            },
            h('div', { className: 'rc-card' },
              discovered.entries.map((entry) => h('div', { key: entry.alias, className: 'rc-row' },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                  h('div', { className: 'rc-name' }, entry.alias),
                  h('div', { className: 'rc-mono rc-muted' },
                    `${entry.user ? `${entry.user}@` : ''}${entry.hostName}:${entry.port}`
                    + `${entry.identityFile ? ` · ${entry.identityFile.split(/[\\\\/]/).pop()}` : ''}`
                    + `${entry.proxyJump || entry.proxyCommand ? ' · proxy, not supported' : ''}`)),
                entry.added
                  ? h('span', { className: 'rc-badge rc-badge-ok' }, 'added')
                  : h('button', {
                    className: 'rc-btn',
                    disabled: busy || Boolean(entry.proxyJump || entry.proxyCommand),
                    onClick: () => importHost(entry.alias),
                  }, 'Add')))))
            : null,
          connections.length === 0 && !editing
            ? h('div', { className: 'rc-empty' },
              h('p', null, 'No connections yet.'),
              h('p', null, 'Add an SSH target; only the SFTP subsystem is required on the other side — no CLI, no agent.'),
              h('button', { className: 'rc-btn rc-btn-primary', onClick: () => setEditing({}) }, 'Add connection'))
            : null,
          connections.length > 0
            ? h(Section, { title: 'Connections' },
              h('div', { className: 'rc-card' },
                connections.map((connection) => {
                  const index = state?.indexes?.[connection.id];
                  const live = state?.states?.[connection.id];
                  return h('div', { key: connection.id, className: 'rc-row' },
                    h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                      h('div', { className: 'rc-name' }, connection.label),
                      h('div', { className: 'rc-mono rc-muted' },
                        `${connection.username ? `${connection.username}@` : ''}${connection.host}:${connection.port} → ${connection.remoteRoot}`),
                      h('div', { className: 'rc-mono rc-muted' },
                        index?.files ? `${index.files} files · ${formatBytes(index.bytes)}${index.truncated ? ' · truncated' : ''}` : 'not indexed')),
                    h('span', { className: `rc-badge ${live?.connected ? 'rc-badge-ok' : ''}` }, live?.connected ? 'connected' : 'idle'),
                    h('div', { className: 'rc-actions' },
                      h('button', { className: 'rc-btn', onClick: () => test(connection.id), disabled: busy }, 'Test'),
                      h('button', { className: 'rc-btn', onClick: () => setBrowsing(connection) }, 'Browse'),
                      h('button', { className: 'rc-btn', onClick: () => setSyncing(connection) }, 'Mirror'),
                      h('button', { className: 'rc-btn', onClick: () => setEditing(connection) }, 'Edit'),
                      h('button', { className: 'rc-btn', onClick: () => remove(connection.id), disabled: busy }, 'Remove')));
                })))
            : null));
    }

    function apply(ctx) {
      injectStyle();
      try {
        document.documentElement.dataset.dshRemoteCtx = '1';
      } catch {
        /* noop */
      }
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.register !== 'function') {
        ctx?.logger?.info?.('[remote-ctx] slots unavailable; panel not registered');
        return;
      }
      try {
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: undefined }, Panel));
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 47, label: () => PANEL_LABEL,
        }, icon));
        ctx?.logger?.info?.('[remote-ctx] sidebar entry + page registered');
      } catch (error) {
        ctx?.logger?.warn?.('[remote-ctx] panel registration failed: ' + (error && error.message));
      }
    }

    function icon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none' },
        h('rect', { x: 1.5, y: 2.5, width: 8, height: 6, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 6.5, y: 7.5, width: 8, height: 6, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M9.5 6.5v1.2', stroke: 'currentColor', strokeWidth: 1.2 }));
    }

    exports.name = 'dsh-remote-ctx-client';
    exports.inject = ['slots', 'layout'];
    exports.apply = apply;
    return module.exports;
  },
});
