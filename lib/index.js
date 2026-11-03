/**
 * dsh-remote-ctx — host half.
 *
 * A DeepSeek Harness plugin that treats a remote host reached over plain SSH as
 * the place a workspace's files live: list it, read and write it, mirror a local
 * workspace onto it, and keep a local index of it so search behaves like a local
 * workspace search. No CLI and no daemon on the target — OpenSSH's SFTP subsystem
 * is the whole contract. Sessions, agents and `$DSH_HOME` stay on this machine.
 *
 * Design rules enforced here:
 *   - every path is confined to the connection's `remoteRoot` (see lib/paths.mjs);
 *   - reads never write; writes are atomic and refuse to leave the root;
 *   - a failing file is a row in the report, never a thrown batch;
 *   - nothing secret (a password) is ever returned to the model or the browser.
 */
import { resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveConfig, toPublicConnection } from './config.mjs';
import { RemoteContext } from './context.mjs';
import { formatConnections, formatDiscovered, formatIndex, formatListing, formatRead, formatSearch, formatSync, formatWrite } from './format.mjs';
import { buildIndex, dropIndex, saveIndex, searchContent, searchIndex, summarizeIndex } from './indexer.mjs';
import { applyPull, applyPush, planPull, planPush, walkLocal } from './mirror.mjs';
import { API_PREFIX, createApiHandler } from './api.mjs';
import { anchorContaining } from './workspace.mjs';

export const name = 'dsh-remote-ctx';
/** Only the tool registry is mandatory; the web panel mounts when a web server exists. */
export const inject = ['tools'];

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      text: { type: 'string', required: true },
      ok: { type: 'boolean', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

const CONNECTION_PARAM = {
  type: 'string',
  description: 'Connection id from remote_ctx_connections. May be omitted when exactly one connection is configured.',
};

/** Every tool this plugin owns; hidden from sessions that are not a remote workspace. */
const REMOTE_TOOL_NAMES = [
  'remote_ctx_connections',
  'remote_ctx_workspace',
  'remote_ctx_ls',
  'remote_ctx_read',
  'remote_ctx_write',
  'remote_ctx_index',
  'remote_ctx_find',
  'remote_ctx_sync',
];

const NOT_REMOTE_WORKSPACE = 'the remote_ctx_* tools act only inside a remote workspace; '
  + 'this session is a local working directory — open the workspace created by 创建为工作区, '
  + 'or use the 远程上下文 panel for a local workspace';

function isRemoteWorkspaceSession(agent, workspacesDir) {
  return Boolean(anchorContaining(agent?.session?.header?.cwd, workspacesDir));
}

/**
 * Hide the remote tools from sessions that are not remote workspaces.
 *
 * Registering them globally put `remote_ctx_*` in every workspace, including a
 * plain local checkout, where they are never the right tool for the files in
 * front of the model. Visibility is restricted per agent when the session is
 * created; the guard re-checks the cwd at dispatch time because a session can
 * `cd` after it was created and a restriction is not revisited.
 */
function scopeRemoteTools(ctx, config) {
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent } = {}) => {
      if (!agent || isRemoteWorkspaceSession(agent, config.workspacesDir)) return;
      const agentCtx = agent.ctx;
      let tools;
      try {
        tools = agentCtx?.tools ?? (typeof agentCtx?.get === 'function' ? agentCtx.get('tools') : undefined);
      } catch {
        tools = undefined;
      }
      if (typeof tools?.restrict !== 'function') return;
      try {
        tools.restrict({ deny: REMOTE_TOOL_NAMES });
      } catch (error) {
        ctx.logger?.warn?.(`[remote-ctx] could not restrict tools for this session: ${error?.message ?? error}`);
      }
    }, { global: true });
  }
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((execution) => {
      const toolName = execution?.name;
      if (typeof toolName !== 'string' || !REMOTE_TOOL_NAMES.includes(toolName)) return undefined;
      return isRemoteWorkspaceSession(execution.agent, config.workspacesDir) ? undefined : NOT_REMOTE_WORKSPACE;
    });
  }
}

function pickConnectionId(context, requested) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  const list = context.store.connections;
  if (list.length === 1) return list[0].id;
  if (list.length === 0) throw new Error('no remote connections configured yet — add one with remote_ctx_connections');
  throw new Error(`connection is required (one of: ${list.map((entry) => entry.id).join(', ')})`);
}

/** Merge an update over the stored record without ever resending the secret. */
function connectionInput(context, args, existing) {
  const raw = {
    id: existing ?? args.id,
    label: args.label ?? undefined,
    host: args.host ?? undefined,
    port: args.port ?? undefined,
    username: args.username ?? undefined,
    remoteRoot: args.remoteRoot ?? undefined,
    localWorkspace: args.localWorkspace ?? undefined,
    hostFingerprint: args.hostFingerprint ?? undefined,
  };
  if (existing) {
    const previous = context.getConnection(existing);
    const publicView = toPublicConnection(previous);
    for (const key of ['label', 'host', 'port', 'username', 'remoteRoot', 'localWorkspace', 'hostFingerprint']) {
      if (raw[key] === undefined) raw[key] = publicView[key];
    }
    raw.auth = publicView.auth;
  }
  if (typeof args.privateKeyPath === 'string' && args.privateKeyPath.trim()) {
    raw.privateKeyPath = args.privateKeyPath.trim();
    raw.auth = { kind: 'key', privateKeyPath: args.privateKeyPath.trim() };
  }
  if (typeof args.password === 'string' && args.password) {
    raw.password = args.password;
    raw.auth = { kind: 'password', password: args.password };
  }
  if (typeof args.agentSocket === 'string' && args.agentSocket.trim()) {
    raw.agentSocket = args.agentSocket.trim();
    raw.auth = { kind: 'agent', agent: args.agentSocket.trim() };
  }
  return raw;
}

async function resolveLocalRoot(ctx, exec, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim());
  const service = ctx.workingDirectory
    ?? (typeof ctx.get === 'function' ? safeGet(ctx, 'workingDirectory') : undefined);
  if (service?.ensure && exec?.agent) {
    try {
      const dir = await service.ensure(exec.agent, exec.signal);
      if (dir) return resolve(dir);
    } catch {
      /* fall through to the explicit-localRoot error */
    }
  }
  throw new Error('localRoot is required: the session workspace could not be resolved, so pass an explicit localRoot');
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

/**
 * Mount the panel API when the host exposes a web server.
 *
 * `webServer` is not in the static inject list: a headless host must keep the
 * tools without a panel. The loader mounts entries concurrently, so the server
 * may not exist at `apply()` time — `ctx.inject` waits for it and the direct
 * call covers a bundle that loads after the web app.
 */
function mountApi(ctx, context) {
  const handler = createApiHandler(context);
  let mounted = false;
  const register = (webCtx) => {
    if (mounted) return;
    let webServer;
    try {
      webServer = webCtx?.webServer ?? safeGet(ctx, 'webServer');
    } catch {
      webServer = undefined;
    }
    if (!webServer || typeof webServer.register !== 'function') return;
    mounted = true;
    try {
      const mount = () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
      const scope = webCtx && typeof webCtx.effect === 'function' ? webCtx : ctx;
      if (typeof scope.effect === 'function') scope.effect(mount, 'dsh-remote-ctx: panel api');
      else mount();
    } catch (error) {
      mounted = false;
      ctx.logger?.warn?.('[remote-ctx] panel api mount failed: ' + (error?.message ?? error));
    }
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register);
  } catch (error) {
    ctx.logger?.warn?.('[remote-ctx] panel api wiring failed: ' + (error?.message ?? error));
  }
  register(ctx);
}

export function apply(ctx, rawConfig, options = {}) {
  const config = resolveConfig(rawConfig);
  // `options` is the test seam: tests pass an in-memory adapter and no SSH
  // client is constructed. Cordis itself only ever passes (ctx, config).
  //
  // `workspaceRegistry` is an optional host capability. A plain property read
  // (or `ctx.get`) does not resolve a service the plugin never declared, so the
  // service is captured through `ctx.inject`, which waits for it without making
  // it mandatory: a host without workspaces still loads the rest of the plugin.
  let registryService;
  const captureRegistry = (injected) => {
    try {
      const found = injected?.workspaceRegistry ?? safeGet(ctx, 'workspaceRegistry');
      if (found) registryService = found;
    } catch {
      /* a host without the service simply keeps registryService undefined */
    }
  };
  // The root context usually has no property for an undeclared service, so wait
  // for the injection as well — and keep whatever was found first.
  captureRegistry(ctx);
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['workspaceRegistry'], captureRegistry);
  } catch (error) {
    ctx.logger?.warn?.('[remote-ctx] workspace registry wiring failed: ' + (error?.message ?? error));
  }

  const context = new RemoteContext(config, {
    ...options,
    registry: options.registry ?? (() => registryService),
  });
  mountApi(ctx, context);
  scopeRemoteTools(ctx, config);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => context.closeAll(), 'dsh-remote-ctx: close ssh pool');
  }

  ctx.tools.register(defineTool({
    name: 'remote_ctx_connections',
    description:
      'List, add, update, remove, test, or import SSH connections for remote context. '
      + 'A connection names a host, an auth method (key file, password, or ssh-agent) and the remote directory that becomes the workspace root. '
      + 'Use action "discover" to list the Hosts already described in the user\'s ~/.ssh/config, then action "import" with host "<alias>" to create one from it. '
      + 'Passwords are write-only: they are never returned by this tool or the panel.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'remove', 'test', 'discover', 'import'],
        description: 'list (default), add, update, remove, test, discover (~/.ssh/config), or import a discovered Host alias.',
      },
      id: { type: 'string', description: 'Connection id (slug). Required for test/remove; auto-derived from label on add.' },
      label: { type: 'string', description: 'Human-readable name shown in the panel and in tool output.' },
      host: { type: 'string', description: 'Hostname or IP address on add/update; on action "import", the Host alias from ~/.ssh/config.' },
      port: { type: 'integer', description: 'SSH port. Default 22.' },
      username: { type: 'string', description: 'SSH username. Default: the target-side default for the auth method.' },
      privateKeyPath: { type: 'string', description: 'Local path to an SSH private key. Selects key auth.' },
      password: { type: 'string', description: 'SSH password. Selects password auth. Stored 0600 under $DSH_HOME, never returned.' },
      agentSocket: { type: 'string', description: 'ssh-agent socket path; $VAR and ${VAR} are expanded. Defaults to $SSH_AUTH_SOCK. Selects agent auth.' },
      remoteRoot: { type: 'string', description: 'Remote directory that is the workspace root, absolute or ~-relative. Default ~.' },
      localWorkspace: { type: 'string', description: 'Local workspace path this connection mirrors. Optional.' },
      hostFingerprint: { type: 'string', description: 'Optional pinned host key, e.g. "SHA256:abc…". Without it ssh2 accepts any host key.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: `Remote connections · ${args.action ?? 'list'}`, kind: 'other', rawInput: args }),
    async execute(args) {
      const action = args.action ?? 'list';
      if (action === 'add' || action === 'update') {
        const existing = action === 'update' ? (args.id ?? undefined) : undefined;
        if (action === 'update' && !existing) throw new Error('update requires id');
        if (action === 'add' && !args.host) throw new Error('add requires host');
        const saved = context.saveConnection(connectionInput(context, args, existing));
        return { text: `saved connection \`${saved.id}\`\n\n${formatConnections(context.listConnections(), context.poolState())}`, ok: true, connections: context.listConnections() };
      }
      if (action === 'remove') {
        if (!args.id) throw new Error('remove requires id');
        context.deleteConnection(args.id);
        return { text: `removed connection \`${args.id}\`\n\n${formatConnections(context.listConnections(), context.poolState())}`, ok: true };
      }
      if (action === 'discover') {
        const discovered = context.discoverSshHosts();
        return { text: formatDiscovered(discovered), ok: true, hosts: discovered.entries };
      }
      if (action === 'import') {
        if (!args.host) throw new Error('import requires host (a Host alias from ~/.ssh/config)');
        const saved = context.importSshHost(String(args.host).trim());
        return {
          text: `imported \`${saved.id}\` from ~/.ssh/config\n\n${formatConnections(context.listConnections(), context.poolState())}`,
          ok: true,
          connection: saved,
        };
      }
      if (action === 'test') {
        const id = pickConnectionId(context, args.id);
        const fs = await context.remote(id);
        const listing = await fs.list(fs.root);
        const pinned = Boolean(context.getConnection(id).hostFingerprint);
        const fingerprint = fs.hostFingerprint;
        const rows = [
          '| home | root | entries | host key |',
          '| --- | --- | --- | --- |',
          `| ${fs.home} | ${fs.root} | ${listing.entries.length} | ${fingerprint ?? 'n/a'}${pinned ? ' (pinned)' : ' (not pinned)'} |`,
        ];
        if (fingerprint && !pinned) {
          rows.push('', `To pin it, call this tool with action "update", id "${id}", hostFingerprint "${fingerprint}".`);
        }
        return {
          text: [`**remote_ctx_connections** · \`${id}\` reachable`, '', ...rows].join('\n'),
          ok: true,
          fingerprint,
          pinned,
        };
      }
      return { text: formatConnections(context.listConnections(), context.poolState()), ok: true, connections: context.listConnections() };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_workspace',
    description:
      'Create a DSH workspace for a remote directory. The workspace is owned over a small local anchor under $DSH_HOME/remote-ctx/workspaces/: its AGENTS.md says the files are remote and that remote_ctx_* tools reach them. '
      + 'Idempotent per (connection, path), and re-running it refreshes the anchor\'s placeholder listing (the names `@` completion offers). Returns the anchor path and whether the workspace registry accepted it.',
    parameters: {
      connection: CONNECTION_PARAM,
      path: { type: 'string', description: 'Remote directory to turn into a workspace, relative to remoteRoot. Default: remoteRoot.' },
      title: { type: 'string', description: 'Workspace title. Default: "<label> · <relative path>".' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Create remote workspace', kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const result = await context.createWorkspace(id, args.path, args.title);
      const lines = [
        `**remote_ctx_workspace** · ${result.registered ? 'workspace registered' : 'anchor created, registry unavailable'}`,
        '',
        '| remote path | local anchor | files | dirs |',
        '| --- | --- | --- | --- |',
        `| ${result.marker.remotePath} | ${result.path} | ${result.listing.files} | ${result.listing.dirs} |`,
        '',
        result.registered
          ? 'It is now in the workspace switcher. The anchor carries a placeholder listing of the remote tree so @file completion and the workspace file panel see the names; AGENTS.md routes content reads to remote_ctx_read. Re-run this tool (or remote_ctx_index) after files appear on the target outside the plugin to refresh that listing.'
          : 'The workspace registry is not available in this host. Add the anchor directory through the workspace picker to register it manually.',
      ];
      return { text: lines.join('\n'), ok: result.registered, workspacePath: result.path };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_ls',
    description:
      'List one directory on the remote host over SFTP: name, type, size and mtime per entry. '
      + 'Paths are confined to the connection remote root; a path outside it is refused.',
    parameters: {
      connection: CONNECTION_PARAM,
      path: { type: 'string', description: 'Remote directory, absolute or relative to remoteRoot. Default: remoteRoot.' },
      limit: { type: 'integer', description: 'Maximum entries to show. Default 200.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Remote listing', kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const fs = await context.remote(id);
      const listing = await fs.list(args.path);
      return { text: formatListing(listing, { limit: args.limit }), ok: true };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_read',
    description:
      'Read a text file from the remote host over SFTP. Bounded by the plugin maxReadBytes (default 256 KiB); '
      + 'the result says whether it was truncated. Use remote_ctx_find first when you do not know the path.',
    parameters: {
      connection: CONNECTION_PARAM,
      path: { type: 'string', description: 'Remote file path, absolute or relative to remoteRoot.' },
      limit: { type: 'integer', description: 'Maximum bytes to read. Defaults to the plugin maxReadBytes.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Read remote file', kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const fs = await context.remote(id);
      const result = await fs.readText(args.path, { maxBytes: args.limit });
      return { text: formatRead(result), ok: true, bytes: result.bytes, truncated: result.truncated };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_write',
    description:
      'Write a text file on the remote host. The write is atomic (temporary file then rename) and confined to the connection remote root. '
      + 'The workspace `@` placeholder for that path is created or refreshed in the same call. '
      + 'Set plugin config allowRemoteWrite: false to make every remote write fail.',
    parameters: {
      connection: CONNECTION_PARAM,
      path: { type: 'string', description: 'Remote file path, absolute or relative to remoteRoot.' },
      content: { type: 'string', required: true, description: 'Full new file content (UTF-8).' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Write remote file', kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const fs = await context.remote(id);
      const result = await fs.writeText(args.path, args.content ?? '');
      dropIndex(config.indexDir, id);
      const placeholders = context.upsertPlaceholders(id, [result.path]);
      return { text: formatWrite(result), ok: true, bytes: result.bytes, placeholders };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_index',
    description:
      'Walk the remote root over SFTP and cache a file index locally (under $DSH_HOME/remote-ctx/index). '
      + 'Bounded by maxIndexFiles and maxIndexDepth. The index is what remote_ctx_find searches; rebuild it after the remote tree changes. '
      + 'The same walk re-materialises the workspace placeholder listing, so a re-index is also how `@` completion picks up new remote files.',
    parameters: {
      connection: CONNECTION_PARAM,
      refresh: { type: 'boolean', description: 'Rebuild even when a cached index exists. Default true.' },
      maxDepth: { type: 'integer', description: 'Override maxIndexDepth for this walk.' },
      maxFiles: { type: 'integer', description: 'Override maxIndexFiles for this walk.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: 'Index remote tree', kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const fs = await context.remote(id);
      const index = await buildIndex(fs, {
        maxDepth: args.maxDepth ?? config.maxIndexDepth,
        maxFiles: args.maxFiles ?? config.maxIndexFiles,
      });
      saveIndex(config.indexDir, index);
      const anchors = await context.refreshAnchors(id, { entries: index.entries, truncated: index.truncated });
      const text = formatIndex(index, summarizeIndex(index));
      const refreshed = anchors.anchors === 0
        ? ''
        : `\n_\`@\` listing refreshed: ${anchors.anchors} workspace anchor(s), ${anchors.files} placeholder file(s), ${anchors.skipped} kept as local edits._`;
      return { text: `${text}${refreshed}`, ok: true, files: index.counts.files, anchors: anchors.anchors };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_find',
    description:
      'Search the cached remote index. mode "path" (default) matches the whole root-relative path, "name" the file name, '
      + '"content" greps file contents over SFTP for plausibly-textual files. Glob wildcards (*, **, ?) are supported in query.',
    parameters: {
      connection: CONNECTION_PARAM,
      query: { type: 'string', required: true, description: 'Substring or glob (*, **, ?) to match.' },
      mode: { type: 'string', enum: ['path', 'name', 'content'], description: 'What to match against. Default "path".' },
      type: { type: 'string', enum: ['all', 'file', 'dir'], description: 'Restrict entry type for path/name modes. Default "all".' },
      limit: { type: 'integer', description: 'Maximum matches. Default 100.' },
      refresh: { type: 'boolean', description: 'Rebuild the index first when the cache is missing or stale.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: `Find remote · ${args.query}`, kind: 'other', rawInput: args }),
    async execute(args) {
      const id = pickConnectionId(context, args.connection);
      const index = await context.indexFor(id, { refresh: args.refresh === true });
      if ((args.mode ?? 'path') === 'content') {
        const fs = await context.remote(id);
        const result = await searchContent(fs, index, { query: args.query, limit: args.limit, maxFiles: 400 });
        return { text: formatSearch('content', result, { query: args.query }), ok: true, hits: result.hits.length };
      }
      const result = searchIndex(index, { query: args.query, mode: args.mode, type: args.type, limit: args.limit });
      return { text: formatSearch(args.mode === 'name' ? 'name' : 'path', result, { query: args.query }), ok: true, matches: result.total };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'remote_ctx_sync',
    description:
      'Mirror a local workspace onto the remote root (direction "push") or the remote root back to local ("pull") over SFTP. '
      + 'Never deletes anything; a file is up to date when its size matches unless force is set. '
      + 'A push also refreshes the workspace `@` placeholder listing for the files it uploads. '
      + 'Pass dryRun to see the plan without writing. localRoot defaults to the calling session workspace.',
    parameters: {
      connection: CONNECTION_PARAM,
      direction: { type: 'string', enum: ['push', 'pull'], description: 'push local -> remote, or pull remote -> local. Default push.' },
      localRoot: { type: 'string', description: 'Local directory to mirror. Defaults to the session workspace.' },
      path: { type: 'string', description: 'Remote subdirectory to mirror into/from. Defaults to remoteRoot.' },
      dryRun: { type: 'boolean', description: 'Report the plan without writing anything.' },
      force: { type: 'boolean', description: 'Upload/download even when sizes match.' },
    },
    output: OUTPUT,
    presentCall: (args) => ({ card: 'generic', title: `Sync · ${args.direction ?? 'push'}`, kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const id = pickConnectionId(context, args.connection);
      const direction = args.direction === 'pull' ? 'pull' : 'push';
      const dryRun = args.dryRun === true;
      const localRoot = await resolveLocalRoot(ctx, exec, args.localRoot);
      const fs = await context.remote(id);
      if (args.path) fs.resolve(args.path); // validate before any walk
      const index = await context.indexFor(id, { refresh: true });
      const local = await walkLocal(localRoot, { maxDepth: config.maxIndexDepth, maxFiles: config.maxIndexFiles });
      const plan = direction === 'push'
        ? planPush(local, index, { force: args.force === true })
        : planPull(index, local, { force: args.force === true });
      const applied = dryRun
        ? undefined
        : direction === 'push' ? await applyPush(fs, plan, { localRoot }) : await applyPull(fs, plan, { localRoot });
      if (!dryRun) {
        dropIndex(config.indexDir, id);
        if (direction === 'push' && applied.ok.length > 0) {
          context.upsertPlaceholders(id, applied.ok.map((row) => fs.absolute(row.path)));
        }
      }
      return { text: formatSync(plan, applied, { dryRun }), ok: !applied || applied.failed.length === 0, localRoot };
    },
  }));
}
