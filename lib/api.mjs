/**
 * HTTP surface for the sidebar panel.
 *
 * One prefix route (`/remote-ctx`) on the host web server; the browser half
 * uses same-origin fetch. Every mutation re-validates the connection id and
 * every remote path goes through `RemoteFs.resolve`, so the panel cannot be
 * turned into "SFTP anywhere on the target". Passwords never leave the host:
 * the response carries `hasPassword`, not the secret.
 */
import { ConnectionError } from './config.mjs';
import { RemotePathError } from './paths.mjs';
import { formatIndex, formatSync } from './format.mjs';
import { dropIndex, searchIndex, summarizeIndex } from './indexer.mjs';
import { applyPull, applyPush, planPull, planPush, walkLocal } from './mirror.mjs';

export const API_PREFIX = '/remote-ctx';
const MAX_BODY_BYTES = 256 * 1024;
// A cached walk is a copy of a tree that keeps moving; past this age the panel
// labels it as possibly stale instead of presenting old results as current.
const INDEX_STALE_MS = 30 * 60 * 1000;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new ApiError(413, 'body-too-large', 'request body exceeds 256 KiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new ApiError(400, 'bad-json', 'request body is not valid JSON'));
      }
    });
    req.on('error', rejectBody);
  });
}

function requireId(url, body) {
  const id = (body && typeof body.id === 'string' && body.id) || url.searchParams.get('id');
  if (!id) throw new ApiError(400, 'id-missing', 'connection id is required');
  return id;
}

function wrap(error, fallbackStatus = 500) {
  if (error instanceof ApiError) return error;
  // A refused path is the caller's mistake, not a server fault.
  if (error instanceof RemotePathError) return new ApiError(400, error.code, error.message);
  // A read-only install is a policy refusal, not a server fault.
  if (error?.code === 'REMOTE_WRITE_DISABLED') return new ApiError(403, error.code, error.message);
  // The adapter reports a missing remote path, and a cached adapter may still
  // carry the raw SFTP code 2; both are "not found", not an internal error.
  if (error?.code === 'REMOTE_NOT_FOUND' || error?.code === 2) {
    return new ApiError(404, 'REMOTE_NOT_FOUND', error.message ?? 'remote path not found');
  }
  if (error?.code === 'REMOTE_PERMISSION_DENIED' || error?.code === 3) {
    return new ApiError(403, 'REMOTE_PERMISSION_DENIED', error.message ?? 'permission denied on remote');
  }
  if (error instanceof ConnectionError) {
    const status = error.code === 'CONNECTION_NOT_FOUND' || error.code === 'SSH_HOST_NOT_FOUND' ? 404
      : error.code === 'CONNECTION_EXISTS' ? 409 : 400;
    return new ApiError(status, error.code, error.message);
  }
  return new ApiError(fallbackStatus, error?.code ?? 'remote-error', error?.message ?? String(error));
}

/** A NUL byte is the one signal that a "text" read is actually a binary file. */
function looksBinary(text) {
  return typeof text === 'string' && text.includes('\u0000');
}

async function handle(context, req, res, pathname, url) {
  const method = req.method ?? 'GET';

  if (pathname === '/api/state' && method === 'GET') {
    const connections = context.listConnections();
    const states = context.poolState();
    const indexes = Object.fromEntries(connections.map((connection) => [connection.id, summarizeIndex(context.readIndex(connection.id))]));
    json(res, 200, { ok: true, data: { connections, states, indexes } });
    return;
  }

  if (pathname === '/api/connections' && method === 'GET') {
    json(res, 200, { ok: true, data: { connections: context.listConnections(), states: context.poolState() } });
    return;
  }

  if (pathname === '/api/connections' && method === 'POST') {
    const body = await readBody(req);
    const record = body.connection && typeof body.connection === 'object' ? body.connection : body;
    const saved = context.saveConnection(record);
    json(res, 200, { ok: true, data: { connection: saved } });
    return;
  }

  if (pathname === '/api/connections' && method === 'DELETE') {
    const id = requireId(url);
    context.deleteConnection(id);
    json(res, 200, { ok: true, data: { id } });
    return;
  }

  if (pathname === '/api/ssh-config' && method === 'GET') {
    const discovered = context.discoverSshHosts();
    json(res, 200, {
      ok: true,
      data: {
        path: discovered.path,
        missing: discovered.missing,
        unresolvedIncludes: discovered.unresolvedIncludes,
        entries: discovered.entries.map((entry) => ({
          alias: entry.alias,
          hostName: entry.hostName,
          user: entry.user,
          port: entry.port,
          identityFile: entry.identityFile,
          proxyJump: entry.proxyJump,
          proxyCommand: entry.proxyCommand,
          id: entry.id,
          added: entry.added,
        })),
      },
    });
    return;
  }

  if (pathname === '/api/ssh-config/import' && method === 'POST') {
    const body = await readBody(req);
    const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
    if (!alias) throw new ApiError(400, 'alias-missing', 'alias is required');
    const connection = context.importSshHost(alias);
    json(res, 200, { ok: true, data: { connection } });
    return;
  }

  if (pathname === '/api/test' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const fs = await context.remote(id);
    const listing = await fs.list(fs.root);
    const connection = context.getConnection(id);
    json(res, 200, {
      ok: true,
      data: {
        id,
        home: fs.home,
        root: fs.root,
        entries: listing.entries.length,
        // What the target presented, and whether the user already pinned a key.
        fingerprint: fs.hostFingerprint ?? undefined,
        pinned: Boolean(connection.hostFingerprint),
      },
    });
    return;
  }

  if (pathname === '/api/trust' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const connection = context.getConnection(id);
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
    if (!fingerprint) throw new ApiError(400, 'fingerprint-missing', 'fingerprint is required: run the connection test first and pass the SHA256 value it reports');
    // Reuse the stored record so the secret is preserved: normalizeConnection
    // takes the password/passphrase from `previous` when the body has none.
    const publicView = context.listConnections().find((entry) => entry.id === connection.id);
    const saved = context.saveConnection({ ...publicView, hostFingerprint: fingerprint });
    // The pool still holds the implicitly trusted connection; the pin must
    // apply to the next one, so drop it and let the next call re-verify.
    await context.close(id);
    json(res, 200, { ok: true, data: { connection: saved } });
    return;
  }

  if (pathname === '/api/browse' && method === 'GET') {
    const id = requireId(url);
    const fs = await context.remote(id);
    const listing = await fs.list(url.searchParams.get('path') ?? undefined);
    json(res, 200, {
      ok: true,
      data: {
        path: listing.path,
        relative: listing.relative,
        root: fs.root,
        entries: listing.entries.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs })),
      },
    });
    return;
  }

  if (pathname === '/api/file' && method === 'GET') {
    const id = requireId(url);
    const requested = url.searchParams.get('path');
    if (!requested) throw new ApiError(400, 'path-missing', 'path is required');
    const fs = await context.remote(id);
    const info = await fs.stat(requested);
    if (info.type === 'dir') throw new ApiError(400, 'path-is-directory', 'that remote path is a directory; browse it instead');
    const limit = Number(url.searchParams.get('limit'));
    const result = await fs.readText(requested, { maxBytes: Number.isFinite(limit) && limit > 0 ? limit : undefined });
    json(res, 200, {
      ok: true,
      data: {
        path: result.path,
        relative: fs.relative(result.path),
        text: result.text,
        bytes: result.bytes,
        size: info.size,
        mtimeMs: info.mtimeMs,
        truncated: result.truncated,
        binary: looksBinary(result.text),
      },
    });
    return;
  }

  if (pathname === '/api/file' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const requested = typeof body.path === 'string' ? body.path.trim() : '';
    if (!requested) throw new ApiError(400, 'path-missing', 'path is required');
    if (typeof body.content !== 'string') throw new ApiError(400, 'content-missing', 'content must be a string (utf-8 text)');
    const fs = await context.remote(id);
    fs.resolve(requested); // refuse a path outside the root before touching the target
    const before = await fs.stat(requested).catch((error) => {
      if (error?.code === 'REMOTE_NOT_FOUND' || error?.code === 2) return undefined;
      throw error;
    });
    if (before && before.type === 'dir') throw new ApiError(400, 'path-is-directory', 'a directory cannot be saved as a file');
    if (before && typeof body.expectedMtimeMs === 'number' && before.mtimeMs !== body.expectedMtimeMs) {
      throw new ApiError(409, 'file-changed', 'the remote file changed since it was read; reload it before saving');
    }
    const result = await fs.writeText(requested, body.content);
    dropIndex(context.config.indexDir, id);
    context.invalidateFileReference(id);
    json(res, 200, { ok: true, data: { path: result.path, bytes: result.bytes } });
    return;
  }

  if (pathname === '/api/workspace' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const result = await context.createWorkspace(id, body.path, body.title);
    json(res, 200, {
      ok: true,
      data: {
        workspacePath: result.path,
        remotePath: result.marker.remotePath,
        created: result.created,
        pruned: result.pruned,
        registered: result.registered,
        workspace: result.workspace,
      },
    });
    return;
  }

  if (pathname === '/api/index' && method === 'GET') {
    const id = requireId(url);
    json(res, 200, { ok: true, data: { summary: summarizeIndex(context.readIndex(id)) } });
    return;
  }

  if (pathname === '/api/index' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const index = await context.indexFor(id, { refresh: true });
    context.invalidateFileReference(id);
    json(res, 200, {
      ok: true,
      data: { summary: summarizeIndex(index), text: formatIndex(index, summarizeIndex(index)) },
    });
    return;
  }

  if (pathname === '/api/find' && method === 'GET') {
    const id = requireId(url);
    const query = (url.searchParams.get('query') ?? '').trim();
    if (!query) throw new ApiError(400, 'query-missing', 'query is required');
    const index = context.readIndex(id);
    const summary = summarizeIndex(index);
    if (!index) {
      json(res, 200, {
        ok: true,
        data: { entries: [], total: 0, truncated: false, summary, missing: true, stale: true },
      });
      return;
    }
    const mode = url.searchParams.get('mode') === 'name' ? 'name' : 'path';
    const type = url.searchParams.get('type');
    const limit = Number(url.searchParams.get('limit'));
    const result = searchIndex(index, {
      query,
      mode,
      type: ['file', 'dir'].includes(type) ? type : 'all',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    });
    json(res, 200, {
      ok: true,
      data: {
        ...result,
        summary,
        missing: false,
        stale: summary.ageMs === undefined || summary.ageMs > INDEX_STALE_MS,
      },
    });
    return;
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const connection = context.getConnection(id);
    const direction = body.direction === 'pull' ? 'pull' : 'push';
    const localRoot = typeof body.localRoot === 'string' && body.localRoot.trim()
      ? body.localRoot.trim()
      : connection.localWorkspace;
    if (!localRoot) {
      throw new ApiError(400, 'local-root-missing', 'localRoot is required (set connection.localWorkspace to make it the default)');
    }
    const fs = await context.remote(id);
    if (body.path) fs.resolve(body.path);
    const index = await context.indexFor(id, { refresh: true });
    const local = await walkLocal(localRoot, { maxDepth: context.config.maxIndexDepth, maxFiles: context.config.maxIndexFiles });
    const plan = direction === 'push'
      ? planPush(local, index, { force: body.force === true })
      : planPull(index, local, { force: body.force === true });
    const applied = body.dryRun === true
      ? undefined
      : direction === 'push' ? await applyPush(fs, plan, { localRoot }) : await applyPull(fs, plan, { localRoot });
    // A pushed file is a new remote file: drop the cached listing so `@` sees it.
    if (applied && direction === 'push' && applied.ok.length > 0) context.invalidateFileReference(id);
    json(res, 200, {
      ok: true,
      data: {
        direction,
        localRoot,
        plan: { pending: (direction === 'push' ? plan.uploads : plan.downloads).length, skipped: plan.skipped.length, bytes: plan.bytes, rows: plan.rows.slice(0, 200) },
        applied,
        text: formatSync(plan, applied, { dryRun: body.dryRun === true }),
      },
    });
    return;
  }


  throw new ApiError(404, 'not-found', `no route for ${method} ${pathname}`);
}

/** Build the request handler mounted at API_PREFIX. */
export function createApiHandler(context) {
  return async function handler(req, res) {
    let pathname = '/';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      if (pathname.startsWith(API_PREFIX)) pathname = pathname.slice(API_PREFIX.length) || '/';
    } catch {
      json(res, 400, { ok: false, error: { code: 'bad-url', message: 'malformed request URL' } });
      return;
    }
    try {
      await handle(context, req, res, pathname, url);
    } catch (error) {
      const wrapped = wrap(error);
      if (!(error instanceof ApiError)) {
        context.logger?.warn?.(`[remote-ctx] ${wrapped.code}: ${wrapped.message}`);
      }
      json(res, wrapped.status, { ok: false, error: { code: wrapped.code, message: wrapped.message } });
    }
  };
}
