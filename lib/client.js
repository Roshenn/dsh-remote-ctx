/**
 * dsh-remote-ctx — browser half.
 *
 * One left-sidebar entry plus its main-area page. The page is a two-column
 * workbench: every Host already described in ~/.ssh/config on the left, the
 * connection form (or a connection's detail) on the right. Picking a host only
 * prefills the form — nothing is written until "连接" is pressed — so browsing
 * the list cannot accidentally create records.
 *
 * Talks to the host half over `/remote-ctx/api` (same origin). No SSH code, no
 * secrets, no connection strings are built here.
 *
 * Loaded through the ModuleLoader contract: `window.__ModuleLoader__.load({ id,
 * factory })` returning `{ name, inject, apply }`.
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
    const PANEL_LABEL = '远程上下文';

    const CSS = `
      .rc-root { box-sizing: border-box; height: 100%; min-height: 0; display: flex; flex-direction: column;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--rc-fg); background: var(--rc-bg); }
      .rc-root *, .rc-root *::before, .rc-root *::after { box-sizing: border-box; }
      .rc-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 18px;
        border-bottom: 1px solid var(--rc-line); }
      .rc-title { font-size: 15px; font-weight: 600; margin: 0; }
      .rc-grow { flex: 1 1 auto; }

      /* Two-column workbench: rail fixed, detail fluid, each scrolls alone. */
      .rc-workbench { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 288px minmax(0, 1fr); }
      .rc-rail { min-height: 0; overflow: auto; border-right: 1px solid var(--rc-line); padding: 6px 8px 12px; }
      .rc-rail-head { display: flex; align-items: center; gap: 8px; padding: 10px 8px 6px; }
      .rc-rail-title { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: var(--rc-muted);
        text-transform: uppercase; }
      .rc-icon-btn { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
        border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--rc-muted);
        font-size: 14px; line-height: 1; cursor: pointer; }
      .rc-icon-btn:hover { border-color: var(--rc-line); color: var(--rc-fg); }
      .rc-rail-list { display: flex; flex-direction: column; gap: 2px; }
      .rc-rail-row { display: flex; flex-direction: column; align-items: stretch; gap: 1px; width: 100%;
        padding: 6px 9px; margin: 0; border: 0; border-left: 2px solid transparent; border-radius: 7px;
        background: transparent; color: var(--rc-fg); text-align: left; cursor: pointer; }
      .rc-rail-row:hover:not(:disabled) { background: color-mix(in srgb, var(--rc-accent) 8%, transparent); }
      .rc-rail-row.is-selected { background: color-mix(in srgb, var(--rc-accent) 12%, transparent);
        border-left-color: var(--rc-accent); }
      .rc-rail-row:disabled { opacity: .5; cursor: not-allowed; }
      .rc-rail-row:focus-visible { outline: 2px solid var(--rc-accent); outline-offset: -2px; }
      .rc-rail-name { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rc-rail-sub { font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--rc-muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rc-rail-foot { margin-top: 10px; padding: 8px 9px 0; border-top: 1px solid var(--rc-line);
        font: 10.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--rc-muted);
        word-break: break-all; }

      .rc-detail { min-height: 0; overflow: auto; padding: 18px 22px 40px; }
      .rc-detail-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
      .rc-detail-title { margin: 0; font-size: 15px; font-weight: 600; }
      .rc-detail-sub { margin-top: 2px; font-size: 12px; color: var(--rc-muted); }
      .rc-kv { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 8px 16px; margin: 0 0 18px; }
      .rc-kv dt { font-size: 12px; color: var(--rc-muted); }
      .rc-kv dd { margin: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
        word-break: break-all; }

      .rc-form { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
      .rc-field-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px; gap: 12px; }
      .rc-field-row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .rc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .rc-label { font-size: 12px; color: var(--rc-muted); }
      .rc-input, .rc-select { height: 32px; width: 100%; padding: 0 9px; border-radius: 7px;
        border: 1px solid var(--rc-line); background: var(--rc-bg); color: var(--rc-fg); font: 12.5px/1.5 inherit; }
      .rc-input:focus, .rc-select:focus { outline: none; border-color: var(--rc-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--rc-accent) 22%, transparent); }
      .rc-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--rc-line); border-radius: 8px;
        background: var(--rc-bg); }
      .rc-seg button { height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
        color: var(--rc-muted); font-size: 12px; cursor: pointer; }
      .rc-seg button.is-active { background: var(--rc-card); color: var(--rc-fg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
      .rc-advanced { border-top: 1px dashed var(--rc-line); padding-top: 12px; }
      .rc-advanced summary { cursor: pointer; font-size: 12px; color: var(--rc-muted); }
      .rc-advanced[open] summary { margin-bottom: 12px; }
      .rc-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
      .rc-search { display: flex; gap: 8px; align-items: center; margin: 0 0 12px; }
      .rc-search-input { flex: 1 1 auto; min-width: 0; }
      .rc-results { margin-bottom: 12px; }

      .rc-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--rc-line);
        background: var(--rc-card); color: var(--rc-fg); font-size: 12px; cursor: pointer; }
      .rc-btn:hover:not(:disabled) { border-color: var(--rc-accent); }
      .rc-btn:disabled { opacity: .45; cursor: default; }
      .rc-btn-primary { background: var(--rc-accent); border-color: var(--rc-accent); color: #fff; }
      .rc-btn-danger { color: var(--rc-danger); border-color: color-mix(in srgb, var(--rc-danger) 45%, transparent); }
      .rc-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .rc-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px;
        border: 1px solid var(--rc-line); font-size: 10.5px; font-weight: 400; color: var(--rc-muted); white-space: nowrap; }
      .rc-badge-ok { color: var(--rc-ok); border-color: color-mix(in srgb, var(--rc-ok) 40%, transparent); }
      .rc-badge-warn { color: var(--rc-warn); border-color: color-mix(in srgb, var(--rc-warn) 40%, transparent); }
      .rc-hint { padding: 8px 9px; font-size: 11.5px; color: var(--rc-muted); }
      .rc-error { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
        color: var(--rc-danger); border: 1px solid color-mix(in srgb, var(--rc-danger) 35%, transparent); }
      .rc-ok { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
        color: var(--rc-ok); border: 1px solid color-mix(in srgb, var(--rc-ok) 35%, transparent); }
      .rc-empty { padding: 44px 0; text-align: center; color: var(--rc-muted); }
      .rc-pre { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--rc-line);
        background: var(--rc-bg); font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
        white-space: pre-wrap; max-height: 260px; overflow: auto; }
      .rc-file-pre { max-height: none; min-height: 220px; }
      .rc-editor { width: 100%; min-height: 320px; margin-top: 10px; padding: 12px; resize: vertical;
        border-radius: 8px; border: 1px solid var(--rc-line); background: var(--rc-bg); color: var(--rc-fg);
        font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
      .rc-editor:focus { outline: none; border-color: var(--rc-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--rc-accent) 22%, transparent); }
      .rc-meta { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--rc-muted); white-space: nowrap; }
      .rc-crumb { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      .rc-card { border: 1px solid var(--rc-line); border-radius: 10px; background: var(--rc-card); }
      .rc-list { margin: 0; padding: 0; list-style: none; }
      .rc-entry { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-radius: 6px; cursor: default; }
      .rc-entry-dir { cursor: pointer; }
      .rc-entry-dir:hover { background: color-mix(in srgb, var(--rc-accent) 10%, transparent); }
      .rc-entry-file { cursor: pointer; }
      .rc-entry-file:hover { background: color-mix(in srgb, var(--rc-accent) 8%, transparent); }
      .rc-kind { flex: 0 0 34px; font-size: 11px; color: var(--rc-muted); }
      .rc-ename { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
      .rc-esize { flex: 0 0 70px; text-align: right; font-size: 11px; color: var(--rc-muted); }
      .rc-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; word-break: break-all; }
      .rc-muted { color: var(--rc-muted); }
      :root { --rc-bg: #ffffff; --rc-card: #ffffff; --rc-fg: #1f2328; --rc-muted: #6b7280; --rc-line: #e5e7eb;
        --rc-accent: #3b82f6; --rc-ok: #15803d; --rc-warn: #b45309; --rc-danger: #b91c1c; }
      [data-theme="dark"] { --rc-bg: #17181a; --rc-card: #1e1f22; --rc-fg: #e6e7e9; --rc-muted: #9aa0a6;
        --rc-line: #2c2e33; --rc-accent: #5b9cff; --rc-ok: #4ade80; --rc-warn: #fbbf24; --rc-danger: #f87171; }

      /* Narrow windows: stack the rail above the detail instead of scrolling sideways. */
      @media (max-width: 720px) {
        .rc-workbench { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 240px) minmax(0, 1fr); }
        .rc-rail { border-right: 0; border-bottom: 1px solid var(--rc-line); }
      }
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
      if (!body.ok) {
        const error = new Error(body.error?.message ?? `HTTP ${response.status}`);
        error.code = body.error?.code;
        throw error;
      }
      return body.data;
    }

    // Host-side codes that have a one-line fix; the detail line stays below the
    // hint so the exact host/method is still readable.
    const ERROR_HINTS = {
      SSH_AUTH_FAILED: '认证失败：服务器拒绝了当前认证方式。',
      SSH_KEY_UNREADABLE: '私钥无法读取或解析。',
      SSH_AGENT_MISSING: '没有可用的 ssh-agent。',
      SSH_SFTP_UNAVAILABLE: '服务器允许登录，但关闭了 SFTP 子系统。',
      SSH_CONNECT_FAILED: '无法建立 SSH 连接。',
      SSH2_MISSING: '缺少依赖 ssh2。',
    };

    function explainError(cause) {
      const hint = cause?.code ? ERROR_HINTS[cause.code] : undefined;
      const detail = cause?.message ?? String(cause);
      return hint ? `${hint}\n${detail}` : detail;
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }

    /** Local wall-clock time for a remote mtime; `—` when the target gave none. */
    function formatTime(ms) {
      if (!ms) return '—';
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
    }

    // Mirrors INDEX_STALE_MS in lib/api.mjs: the panel labels a cached walk past
    // this age as "possibly stale" instead of presenting it as current.
    const INDEX_STALE_MS = 30 * 60 * 1000;

    /** "3 分钟前" — the age of an index that was built at a known time. */
    function formatAge(ms) {
      if (!Number.isFinite(ms)) return '未知';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return `${hours} 小时前`;
      return `${Math.floor(hours / 24)} 天前`;
    }

    /** Join a root returned by `/api/browse` with one root-relative path. */
    function joinRemote(root, relative) {
      return `${String(root ?? '').replace(/\/+$/, '')}/${relative}`;
    }

    function basename(path) {
      return String(path ?? '').split(/[\\/]/).pop();
    }

    const Field = ({ label, children }) => h('label', { className: 'rc-field' },
      h('span', { className: 'rc-label' }, label), children);
    const Input = (props) => h('input', { className: 'rc-input', ...props });

    function Seg({ value, options, onChange, disabled }) {
      return h('div', { className: 'rc-seg', role: 'group' },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          className: value === option.value ? 'is-active' : '',
          disabled,
          onClick: () => onChange(option.value),
        }, option.label)));
    }

    /** Prefill a form from one ~/.ssh/config Host entry. */
    function draftFromHost(entry) {
      return {
        id: '',
        label: entry.alias,
        host: entry.hostName,
        port: entry.port,
        username: entry.user ?? '',
        remoteRoot: '~',
        localWorkspace: '',
        hostFingerprint: '',
        auth: entry.identityFile
          ? { kind: 'key', privateKeyPath: entry.identityFile }
          : { kind: 'agent' },
        alias: entry.alias,
      };
    }

    function ConnectionForm({ initial, hosts, busy, submitLabel, onSubmit, onCancel }) {
      const [form, setForm] = useState(() => ({
        alias: initial?.alias ?? '',
        id: initial?.id ?? '',
        label: initial?.label ?? '',
        host: initial?.host ?? '',
        port: initial?.port ?? 22,
        username: initial?.username ?? '',
        remoteRoot: initial?.remoteRoot ?? '~',
        localWorkspace: initial?.localWorkspace ?? '',
        hostFingerprint: initial?.hostFingerprint ?? '',
        authKind: initial?.auth?.kind ?? (hosts?.length ? 'key' : 'password'),
        privateKeyPath: initial?.auth?.privateKeyPath ?? '',
        passphrase: '',
        password: '',
        agent: initial?.auth?.agent ?? '',
      }));
      const [advanced, setAdvanced] = useState(false);
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

      const pickHost = (event) => {
        const alias = event.target.value;
        if (!alias) {
          setForm({ ...form, alias: '' });
          return;
        }
        const entry = (hosts ?? []).find((host) => host.alias === alias);
        if (!entry) return;
        setForm({
          ...form,
          alias,
          id: '',
          label: entry.alias,
          host: entry.hostName,
          port: entry.port,
          username: entry.user ?? '',
          authKind: entry.identityFile ? 'key' : 'agent',
          privateKeyPath: entry.identityFile ?? '',
        });
      };

      const submit = (event) => {
        event.preventDefault();
        onSubmit({
          id: form.id.trim() || undefined,
          label: form.label.trim() || form.host.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim() || undefined,
          remoteRoot: form.remoteRoot.trim() || '~',
          localWorkspace: form.localWorkspace.trim() || undefined,
          hostFingerprint: form.hostFingerprint.trim() || undefined,
          auth: form.authKind === 'key'
            ? { kind: 'key', privateKeyPath: form.privateKeyPath.trim(), ...(form.passphrase ? { passphrase: form.passphrase } : {}) }
            : form.authKind === 'password'
              ? { kind: 'password', ...(form.password ? { password: form.password } : {}) }
              : { kind: 'agent', ...(form.agent.trim() ? { agent: form.agent.trim() } : {}) },
        });
      };

      const keyReady = form.authKind !== 'key' || form.privateKeyPath.trim() !== '';
      return h('form', { className: 'rc-form', onSubmit: submit },
        (hosts ?? []).length > 0
          ? h(Field, { label: 'SSH 配置别名（可选）' },
            h('select', { className: 'rc-select', value: form.alias, onChange: pickHost },
              h('option', { value: '' }, '不使用别名'),
              hosts.map((host) => h('option', {
                key: host.alias,
                value: host.alias,
                disabled: Boolean(host.proxyJump || host.proxyCommand),
              }, `${host.alias} · ${host.user ? `${host.user}@` : ''}${host.hostName}:${host.port}`))))
          : null,
        h('div', { className: 'rc-field-row' },
          h(Field, { label: '主机' },
            h(Input, { value: form.host, onChange: set('host'), placeholder: '主机地址或 IP，例如 192.168.1.100', required: true })),
          h(Field, { label: '端口' },
            h(Input, { value: form.port, onChange: set('port'), type: 'number', min: 1, max: 65535 }))),
        h('div', { className: 'rc-field-row two' },
          h(Field, { label: '用户名' },
            h(Input, { value: form.username, onChange: set('username'), placeholder: '用户名，例如 root' })),
          h('div', { className: 'rc-field' },
            h('label', { className: 'rc-label' }, '认证方式'),
            h(Seg, {
              value: form.authKind,
              disabled: busy,
              onChange: (value) => setForm({ ...form, authKind: value }),
              options: [
                { value: 'password', label: '密码' },
                { value: 'key', label: '私钥' },
                { value: 'agent', label: 'agent' },
              ],
            }))),
        form.authKind === 'password'
          ? h(Field, { label: '密码' },
            h(Input, {
              value: form.password,
              onChange: set('password'),
              type: 'password',
              placeholder: initial?.auth?.hasPassword ? '留空表示不修改' : '输入 SSH 密码',
            }))
          : null,
        form.authKind === 'key'
          ? h('div', { className: 'rc-field-row two' },
            h(Field, { label: '私钥路径' },
              h(Input, { value: form.privateKeyPath, onChange: set('privateKeyPath'), placeholder: '~/.ssh/id_ed25519', required: true })),
            h(Field, { label: '密钥口令（可选）' },
              h(Input, { value: form.passphrase, onChange: set('passphrase'), type: 'password', placeholder: initial?.auth?.hasPassphrase ? '留空表示不修改' : '' })))
          : null,
        form.authKind === 'agent'
          ? h(Field, { label: 'agent socket（可选）' },
            h(Input, { value: form.agent, onChange: set('agent'), placeholder: '$SSH_AUTH_SOCK' }))
          : null,
        h('div', { className: 'rc-field-row two' },
          h(Field, { label: '远端根目录' },
            h(Input, { value: form.remoteRoot, onChange: set('remoteRoot'), placeholder: '~ 或 /srv/workspace' })),
          h(Field, { label: '本地工作区（可选）' },
            h(Input, { value: form.localWorkspace, onChange: set('localWorkspace'), placeholder: '镜像时使用的本地目录' }))),
        h('details', { className: 'rc-advanced', open: advanced, onToggle: (event) => setAdvanced(event.currentTarget.open) },
          h('summary', null, '高级'),
          h('div', { className: 'rc-field-row two' },
            h(Field, { label: '主机指纹（可选）' },
              h(Input, { value: form.hostFingerprint, onChange: set('hostFingerprint'), placeholder: 'SHA256:…' })),
            initial?.id ? null : h(Field, { label: '连接 id（可选）' },
              h(Input, { value: form.id, onChange: set('id'), placeholder: '留空则按名称生成' })))),
        h('div', { className: 'rc-form-actions' },
          onCancel ? h('button', { type: 'button', className: 'rc-btn', onClick: onCancel, disabled: busy }, '取消') : null,
          h('button', { type: 'submit', className: 'rc-btn rc-btn-primary', disabled: busy || !keyReady }, busy ? '处理中…' : (submitLabel ?? '连接'))));
    }

    function HostRail({ connections, discovered, selected, onSelectHost, onSelectConnection, onNew, onRefresh, busy }) {
      const hosts = discovered?.entries ?? [];
      return h('aside', { className: 'rc-rail' },
        h('div', { className: 'rc-rail-head' },
          h('span', { className: 'rc-rail-title' }, 'SSH 配置'),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-icon-btn', title: '刷新', onClick: onRefresh, disabled: busy }, '⟳')),
        discovered?.missing
          ? h('div', { className: 'rc-hint' }, `未找到 ${discovered.path ?? '~/.ssh/config'}`)
          : hosts.length === 0
            ? h('div', { className: 'rc-hint' }, '配置里没有 Host 条目')
            : h('div', { className: 'rc-rail-list' }, hosts.map((host) => h('button', {
              key: host.alias,
              type: 'button',
              className: `rc-rail-row${selected?.kind === 'host' && selected.alias === host.alias ? ' is-selected' : ''}`,
              disabled: busy || Boolean(host.proxyJump || host.proxyCommand),
              title: host.proxyJump || host.proxyCommand ? '需要 ProxyJump/ProxyCommand，本插件只支持直连' : host.identityFile ?? '',
              onClick: () => onSelectHost(host),
            },
            h('span', { className: 'rc-rail-name' },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, host.alias),
              host.added ? h('span', { className: 'rc-badge rc-badge-ok' }, '已添加') : null,
              host.proxyJump || host.proxyCommand ? h('span', { className: 'rc-badge rc-badge-warn' }, '代理') : null),
            h('span', { className: 'rc-rail-sub' },
              `${host.user ? `${host.user}@` : ''}${host.hostName}:${host.port}`
              + (host.identityFile ? ` · ${basename(host.identityFile)}` : ''))))),
        h('div', { className: 'rc-rail-head' },
          h('span', { className: 'rc-rail-title' }, '已添加'),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-icon-btn', title: '新建连接', onClick: onNew, disabled: busy }, '+')),
        connections.length === 0
          ? h('div', { className: 'rc-hint' }, '还没有连接')
          : h('div', { className: 'rc-rail-list' }, connections.map((connection) => h('button', {
            key: connection.id,
            type: 'button',
            className: `rc-rail-row${selected?.kind === 'connection' && selected.id === connection.id ? ' is-selected' : ''}`,
            onClick: () => onSelectConnection(connection),
          },
          h('span', { className: 'rc-rail-name' }, connection.label),
          h('span', { className: 'rc-rail-sub' },
            `${connection.username ? `${connection.username}@` : ''}${connection.host}:${connection.port} → ${connection.remoteRoot}`)))),
        h('div', { className: 'rc-rail-foot' }, discovered?.path ?? '~/.ssh/config'));
    }

    function ConnectionDetail({ connection, live, index, busy, deleting, onTest, onBrowse, onMirror, onCreateWorkspace, onEdit, onDelete }) {
      const auth = connection.auth?.kind === 'key'
        ? `私钥 · ${basename(connection.auth.privateKeyPath)}${connection.auth.hasPassphrase ? '（带口令）' : ''}`
        : connection.auth?.kind === 'password' ? '密码（已保存）' : 'ssh-agent';
      return h('div', null,
        h('div', { className: 'rc-detail-head' },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('h2', { className: 'rc-detail-title' }, connection.label),
            h('div', { className: 'rc-detail-sub' },
              `${connection.username ? `${connection.username}@` : ''}${connection.host}:${connection.port}`)),
          h('span', { className: `rc-badge ${live?.connected ? 'rc-badge-ok' : ''}` }, live?.connected ? '已连接' : '未连接')),
        h('dl', { className: 'rc-kv' },
          h('dt', null, '远端根目录'), h('dd', null, connection.remoteRoot),
          h('dt', null, '本地工作区'), h('dd', null, connection.localWorkspace ?? '未设置'),
          h('dt', null, '认证'), h('dd', null, auth),
          h('dt', null, '主机指纹'), h('dd', null, connection.hostFingerprint ?? '未固定'),
          h('dt', null, '索引'), h('dd', null, index?.builtAt
            ? `${index.files} 个文件 · ${formatBytes(index.bytes)} · ${formatAge(index.ageMs)}${index.truncated ? ' · 已截断' : ''}${Number.isFinite(index.ageMs) && index.ageMs > INDEX_STALE_MS ? ' · 可能已过期' : ''}`
            : '尚未建立')),
        h('div', { className: 'rc-actions' },
          h('button', { className: 'rc-btn rc-btn-primary', onClick: onTest, disabled: busy }, busy ? '测试中…' : '测试连接'),
          h('button', { className: 'rc-btn', onClick: onBrowse }, '浏览目录'),
          h('button', { className: 'rc-btn', onClick: onMirror }, '镜像'),
          h('button', { className: 'rc-btn', onClick: onCreateWorkspace }, '创建工作区'),
          h('button', { className: 'rc-btn', onClick: onEdit }, '编辑'),
          h('button', {
            className: `rc-btn ${deleting ? 'rc-btn-danger' : ''}`,
            onClick: onDelete,
            disabled: busy,
          }, deleting ? '确认删除' : '删除')));
    }

    function Browse({ connectionId, root, onBack, onCreateWorkspace, onOpenFile }) {
      const [path, setPath] = useState(root);
      const [listing, setListing] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');
      const [query, setQuery] = useState('');
      const [results, setResults] = useState(null);
      const [searching, setSearching] = useState(false);
      const [searchError, setSearchError] = useState('');

      const load = (target) => {
        setBusy(true);
        setError('');
        api(`/browse?id=${encodeURIComponent(connectionId)}&path=${encodeURIComponent(target ?? '')}`)
          .then((data) => {
            setListing(data);
            setPath(data.path);
          })
          .catch((cause) => setError(explainError(cause)))
          .finally(() => setBusy(false));
      };
      useEffect(() => { load(root); }, [connectionId]);

      const runSearch = (value) => {
        const needle = String(value ?? query).trim();
        if (!needle) return;
        setSearching(true);
        setSearchError('');
        api(`/find?id=${encodeURIComponent(connectionId)}&query=${encodeURIComponent(needle)}&limit=100`)
          .then((data) => setResults({ ...data, query: needle }))
          .catch((cause) => setSearchError(explainError(cause)))
          .finally(() => setSearching(false));
      };

      const index = () => {
        setBusy(true);
        setNote('');
        setError('');
        api('/index', { method: 'POST', body: { id: connectionId } })
          .then((data) => {
            setNote(`已索引 ${data.summary.files} 个文件，${data.summary.dirs} 个目录`);
            // A rebuild is how a stale search becomes current again: re-run it.
            if (results?.query) runSearch(results.query);
          })
          .catch((cause) => setError(explainError(cause)))
          .finally(() => setBusy(false));
      };

      const parent = listing?.path && listing.path !== listing.root
        ? listing.path.slice(0, Math.max(listing.path.lastIndexOf('/'), 1))
        : undefined;

      return h('div', null,
        h('div', { className: 'rc-crumb' },
          h('button', { className: 'rc-btn', onClick: onBack }, '← 返回'),
          h('button', { className: 'rc-btn', onClick: () => load(), disabled: busy }, '根目录'),
          parent ? h('button', { className: 'rc-btn', onClick: () => load(parent), disabled: busy }, '上一级') : null,
          h('span', { className: 'rc-mono rc-muted' }, listing?.path ?? path),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-btn rc-btn-primary', onClick: () => onCreateWorkspace(listing?.path ?? path), disabled: busy || !listing }, '创建为工作区'),
          h('button', { className: 'rc-btn', onClick: index, disabled: busy || !listing }, '在此建立索引')),
        h('form', {
          className: 'rc-search',
          onSubmit: (event) => { event.preventDefault(); runSearch(); },
        },
        h('input', {
          className: 'rc-input rc-search-input',
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: '在本地索引里搜路径或文件名（支持 * ? **）',
          'aria-label': '搜索索引',
        }),
        h('button', { type: 'submit', className: 'rc-btn rc-btn-primary', disabled: searching || !query.trim() }, searching ? '搜索中…' : '搜索'),
        results ? h('button', {
          type: 'button',
          className: 'rc-btn',
          onClick: () => { setResults(null); setSearchError(''); },
        }, '清除') : null),
        searchError ? h('div', { className: 'rc-error' }, searchError) : null,
        results
          ? h('div', { className: 'rc-card rc-results' },
            h('div', { className: 'rc-hint' },
              results.missing
                ? '还没有索引：先在当前目录建立索引，再搜索。'
                : `「${results.query}」· ${results.total} 个匹配 · 索引 ${formatAge(results.summary?.ageMs)}${results.stale ? ' · 可能已过期' : ''}`),
            results.missing || results.stale
              ? h('div', { className: 'rc-actions', style: { padding: '0 9px 8px' } },
                h('button', { className: 'rc-btn', onClick: index, disabled: busy }, busy ? '建立中…' : '建立 / 重建索引'))
              : null,
            results.entries.length > 0
              ? h('ul', { className: 'rc-list' }, results.entries.map((entry) => h('li', {
                key: entry.path,
                className: `rc-entry${entry.type === 'dir' ? ' rc-entry-dir' : ' rc-entry-file'}`,
                onClick: entry.type === 'dir'
                  ? () => load(joinRemote(listing?.root ?? root, entry.path))
                  : () => onOpenFile(joinRemote(listing?.root ?? root, entry.path)),
              },
              h('span', { className: 'rc-kind' }, entry.type === 'dir' ? 'dir' : 'file'),
              h('span', { className: 'rc-ename' }, entry.path),
              h('span', { className: 'rc-esize' }, entry.type === 'file' ? formatBytes(entry.size) : ''))))
              : h('div', { className: 'rc-hint' }, '没有匹配'))
          : null,
        error ? h('div', { className: 'rc-error' }, error) : null,
        note ? h('div', { className: 'rc-ok' }, note) : null,
        !listing && busy ? h('div', { className: 'rc-empty' }, '读取中…') : null,
        listing
          ? h('div', { className: 'rc-card' },
            h('ul', { className: 'rc-list' },
              listing.entries.map((entry) => h('li', {
                key: entry.name,
                className: `rc-entry${entry.type === 'dir' ? ' rc-entry-dir' : ''}${entry.type === 'file' ? ' rc-entry-file' : ''}`,
                title: entry.type === 'file' ? '点击预览 / 编辑' : undefined,
                onClick: entry.type === 'dir'
                  ? () => load(`${listing.path}/${entry.name}`)
                  : entry.type === 'file' ? () => onOpenFile(`${listing.path}/${entry.name}`) : undefined,
              },
              h('span', { className: 'rc-kind' }, entry.type === 'dir' ? 'dir' : entry.type === 'link' ? 'link' : 'file'),
              h('span', { className: 'rc-ename' }, entry.name),
              h('span', { className: 'rc-esize' }, entry.type === 'file' ? formatBytes(entry.size) : '')))))
          : null);
    }

    /**
     * One remote file: read, preview, edit, save.
     *
     * The save carries the mtime the file was read at, so a file changed on the
     * target in between is refused (409) instead of silently overwritten. A
     * truncated read stays read-only: writing back a prefix would destroy the
     * rest of the file.
     */
    function FileView({ connectionId, path, onBack }) {
      const [file, setFile] = useState(null);
      const [draft, setDraft] = useState('');
      const [editing, setEditing] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');

      const reload = () => api(`/file?id=${encodeURIComponent(connectionId)}&path=${encodeURIComponent(path)}`)
        .then((data) => {
          setFile(data);
          setDraft(data.text);
          setEditing(false);
        })
        .catch((cause) => setError(explainError(cause)));

      useEffect(() => {
        setFile(null);
        setError('');
        setNotice('');
        setBusy(true);
        reload().finally(() => setBusy(false));
      }, [connectionId, path]);

      const save = () => {
        setBusy(true);
        setError('');
        setNotice('');
        api('/file', {
          method: 'POST',
          body: { id: connectionId, path: file.path, content: draft, expectedMtimeMs: file.mtimeMs },
        })
          .then((data) => {
            setNotice(`已保存 ${formatBytes(data.bytes)}`);
            return reload();
          })
          .catch((cause) => setError(explainError(cause)))
          .finally(() => setBusy(false));
      };

      const readOnly = Boolean(file && (file.truncated || file.binary));
      return h('div', null,
        h('div', { className: 'rc-crumb' },
          h('button', { className: 'rc-btn', onClick: onBack }, '← 返回'),
          h('span', { className: 'rc-mono rc-muted' }, file?.path ?? path),
          h('span', { className: 'rc-grow' }),
          file ? h('span', { className: 'rc-meta' }, `${formatBytes(file.size)} · ${formatTime(file.mtimeMs)}`) : null,
          !editing
            ? h('button', {
              className: 'rc-btn',
              onClick: () => { setNotice(''); setEditing(true); },
              disabled: busy || !file || readOnly,
              title: readOnly ? '截断或二进制的文件不进入编辑，避免覆盖原文件' : '编辑这个文件',
            }, '编辑')
            : null,
          editing ? h('button', {
            className: 'rc-btn',
            onClick: () => { setDraft(file?.text ?? ''); setEditing(false); setError(''); },
            disabled: busy,
          }, '取消') : null,
          editing ? h('button', { className: 'rc-btn rc-btn-primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存') : null),
        error ? h('div', { className: 'rc-error' }, error) : null,
        notice ? h('div', { className: 'rc-ok' }, notice) : null,
        file?.truncated ? h('div', { className: 'rc-hint' }, '读取已截断：只读预览；保存被禁用（截断内容不能用来覆盖原文件）。') : null,
        file?.binary ? h('div', { className: 'rc-hint' }, '看起来是二进制文件：只读预览。') : null,
        busy && !file ? h('div', { className: 'rc-empty' }, '读取中…') : null,
        file
          ? editing
            ? h('textarea', {
              className: 'rc-editor',
              value: draft,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
            })
            : h('pre', { className: 'rc-pre rc-file-pre' }, file.text || '（空文件）')
          : null);
    }

    function SyncPanel({ connection, onBack }) {
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
          .catch((cause) => setError(explainError(cause)))
          .finally(() => setBusy(false));
      };

      return h('div', null,
        h('div', { className: 'rc-crumb' },
          h('button', { className: 'rc-btn', onClick: onBack }, '← 返回'),
          h('h2', { className: 'rc-detail-title' }, `镜像 · ${connection.label}`)),
        h('div', { className: 'rc-form' },
          h('div', { className: 'rc-field-row two' },
            h(Field, { label: '方向' },
              h('select', { className: 'rc-select', value: direction, onChange: (event) => setDirection(event.target.value) },
                h('option', { value: 'push' }, 'push — 本地 → 远端'),
                h('option', { value: 'pull' }, 'pull — 远端 → 本地'))),
            h(Field, { label: '本地根目录' },
              h(Input, { value: localRoot, onChange: (event) => setLocalRoot(event.target.value), placeholder: '本地工作区的绝对路径' }))),
          h('div', { className: 'rc-actions' },
            h('label', { className: 'rc-label', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('input', { type: 'checkbox', checked: dryRun, onChange: (event) => setDryRun(event.target.checked) }),
              '只看计划，不写入'),
            h('label', { className: 'rc-label', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
              '大小相同也重传')),
          h('div', { className: 'rc-form-actions' },
            h('span', { className: 'rc-grow' }),
            h('button', { className: 'rc-btn rc-btn-primary', onClick: run, disabled: busy || !localRoot }, busy ? '执行中…' : '运行'))),
        error ? h('div', { className: 'rc-error', style: { marginTop: 12 } }, error) : null,
        result ? h('pre', { className: 'rc-pre' }, result) : null);
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [discovered, setDiscovered] = useState(null);
      const [view, setView] = useState('new');
      const [filePath, setFilePath] = useState('');
      const [selection, setSelection] = useState(null); // { kind: 'host', alias } | { kind: 'connection', id }
      const [draft, setDraft] = useState(null);
      const [draftKey, setDraftKey] = useState(0);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [pendingDelete, setPendingDelete] = useState(null);

      const reload = () => {
        setBusy(true);
        return Promise.all([api('/state'), api('/ssh-config').catch(() => null)])
          .then(([next, ssh]) => { setState(next); setDiscovered(ssh); setError(''); })
          .catch((cause) => setError(explainError(cause)))
          .finally(() => setBusy(false));
      };
      useEffect(() => { reload(); }, []);

      useEffect(() => {
        if (!pendingDelete) return undefined;
        const timer = setTimeout(() => setPendingDelete(null), 3000);
        return () => clearTimeout(timer);
      }, [pendingDelete]);

      const connections = state?.connections ?? [];
      const selected = selection?.kind === 'connection'
        ? connections.find((connection) => connection.id === selection.id) ?? null
        : null;

      const openNew = (initial) => {
        setDraft(initial ?? null);
        setDraftKey((key) => key + 1);
        setView('new');
        setNotice('');
        setError('');
      };

      const selectHost = (host) => {
        setSelection({ kind: 'host', alias: host.alias });
        openNew(draftFromHost(host));
      };

      const selectConnection = (connection) => {
        setSelection({ kind: 'connection', id: connection.id });
        setView('detail');
        setNotice('');
        setError('');
      };

      const connect = async (connection) => {
        setBusy(true);
        setError('');
        setNotice('');
        let savedId = connection.id;
        try {
          const saved = await api('/connections', { method: 'POST', body: { connection } });
          savedId = saved.connection.id;
          await reload();
          setSelection({ kind: 'connection', id: savedId });
          setView('detail');
          try {
            const tested = await api('/test', { method: 'POST', body: { id: savedId } });
            setNotice(`已连接 · ${tested.root}（${tested.entries} 个条目）`);
          } catch (testError) {
            // The record is saved; only the live check failed, so say both things.
            setError(`已保存，连接失败：${explainError(testError)}`);
          }
        } catch (cause) {
          setError(explainError(cause));
        } finally {
          setBusy(false);
          reload();
        }
      };

      const saveEdit = async (connection) => {
        setBusy(true);
        setError('');
        try {
          const saved = await api('/connections', { method: 'POST', body: { connection: { ...connection, id: selected?.id ?? connection.id } } });
          await reload();
          setSelection({ kind: 'connection', id: saved.connection.id });
          setView('detail');
          setNotice('已保存');
        } catch (cause) {
          setError(explainError(cause));
        } finally {
          setBusy(false);
          reload();
        }
      };

      const remove = async (id) => {
        setBusy(true);
        setError('');
        try {
          await api(`/connections?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
          setSelection(null);
          openNew(null);
          setNotice('已删除');
        } catch (cause) {
          setError(explainError(cause));
        } finally {
          setBusy(false);
          reload();
        }
      };

      const testConnection = async (id) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const tested = await api('/test', { method: 'POST', body: { id } });
          setNotice(`已连接 · ${tested.root}（${tested.entries} 个条目）`);
        } catch (cause) {
          setError(explainError(cause));
        } finally {
          setBusy(false);
          reload();
        }
      };

      const createWorkspace = async (connection, remotePath) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const data = await api('/workspace', { method: 'POST', body: { id: connection.id, path: remotePath } });
          setNotice(
            data.registered
              ? `已创建工作区：${data.workspacePath}（已加入工作区列表；已生成 ${data.listing?.files ?? 0} 个文件的占位清单）`
              : `已创建本地锚点：${data.workspacePath}；workspace 注册服务不可用，请在工作区选择器里手动添加该目录`,
          );
        } catch (cause) {
          setError(explainError(cause));
        } finally {
          setBusy(false);
          reload();
        }
      };

      const body = (() => {
        if (view === 'file' && selected && filePath) {
          return h(FileView, { connectionId: selected.id, path: filePath, onBack: () => setView('browse') });
        }
        if (view === 'browse' && selected) {
          return h(Browse, {
            connectionId: selected.id,
            root: selected.remoteRoot,
            onBack: () => setView('detail'),
            onCreateWorkspace: (remotePath) => createWorkspace(selected, remotePath),
            onOpenFile: (path) => { setFilePath(path); setView('file'); },
          });
        }
        if (view === 'mirror' && selected) {
          return h(SyncPanel, { connection: selected, onBack: () => setView('detail') });
        }
        if (view === 'edit' && selected) {
          return h('div', null,
            h('div', { className: 'rc-detail-head' },
              h('div', null,
                h('h2', { className: 'rc-detail-title' }, `编辑 · ${selected.label}`),
                h('div', { className: 'rc-detail-sub' }, '密码与口令留空表示保持原值。'))),
            h(ConnectionForm, {
              key: `edit-${selected.id}-${draftKey}`,
              initial: { ...selected, alias: '' },
              hosts: discovered?.entries ?? [],
              busy,
              submitLabel: '保存',
              onSubmit: saveEdit,
              onCancel: () => setView('detail'),
            }));
        }
        if (view === 'detail' && selected) {
          return h(ConnectionDetail, {
            connection: selected,
            live: state?.states?.[selected.id],
            index: state?.indexes?.[selected.id],
            busy,
            deleting: pendingDelete === selected.id,
            onTest: () => testConnection(selected.id),
            onBrowse: () => setView('browse'),
            onMirror: () => setView('mirror'),
            onCreateWorkspace: () => createWorkspace(selected, selected.remoteRoot),
            onEdit: () => setView('edit'),
            onDelete: () => {
              if (pendingDelete === selected.id) remove(selected.id);
              else setPendingDelete(selected.id);
            },
          });
        }
        return h('div', null,
          h('div', { className: 'rc-detail-head' },
            h('div', null,
              h('h2', { className: 'rc-detail-title' }, '新建连接'),
              h('div', { className: 'rc-detail-sub' }, '填写建立 SSH 连接所需的信息；左侧点选主机可自动带入。'))),
          h(ConnectionForm, {
            key: `new-${draftKey}`,
            initial: draft,
            hosts: discovered?.entries ?? [],
            busy,
            submitLabel: '连接',
            onSubmit: connect,
            onCancel: draft ? () => openNew(null) : undefined,
          }));
      })();

      return h('div', { className: 'rc-root' },
        h('header', { className: 'rc-head' },
          h('h1', { className: 'rc-title' }, '远程上下文'),
          h('span', { className: 'rc-grow' }),
          h('button', { className: 'rc-btn', onClick: reload, disabled: busy }, busy ? '刷新中…' : '刷新')),
        h('div', { className: 'rc-workbench' },
          h(HostRail, {
            connections,
            discovered,
            selected: selection,
            busy,
            onSelectHost: selectHost,
            onSelectConnection: selectConnection,
            onNew: () => { setSelection(null); openNew(null); },
            onRefresh: reload,
          }),
          h('main', { className: 'rc-detail' },
            error ? h('div', { className: 'rc-error' }, error) : null,
            notice ? h('div', { className: 'rc-ok' }, notice) : null,
            body)));
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
