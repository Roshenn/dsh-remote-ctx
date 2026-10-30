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
import { summarizeIndex } from './indexer.mjs';
import { applyPull, applyPush, planPull, planPush, walkLocal } from './mirror.mjs';

export const API_PREFIX = '/remote-ctx';
const MAX_BODY_BYTES = 256 * 1024;

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
  if (error instanceof ConnectionError) {
    const status = error.code === 'CONNECTION_NOT_FOUND' ? 404
      : error.code === 'CONNECTION_EXISTS' ? 409 : 400;
    return new ApiError(status, error.code, error.message);
  }
  return new ApiError(fallbackStatus, error?.code ?? 'remote-error', error?.message ?? String(error));
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

  if (pathname === '/api/test' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const fs = await context.remote(id);
    const listing = await fs.list(fs.root);
    json(res, 200, { ok: true, data: { id, home: fs.home, root: fs.root, entries: listing.entries.length } });
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

  if (pathname === '/api/index' && method === 'GET') {
    const id = requireId(url);
    json(res, 200, { ok: true, data: { summary: summarizeIndex(context.readIndex(id)) } });
    return;
  }

  if (pathname === '/api/index' && method === 'POST') {
    const body = await readBody(req);
    const id = requireId(url, body);
    const index = await context.indexFor(id, { refresh: true });
    json(res, 200, {
      ok: true,
      data: { summary: summarizeIndex(index), text: formatIndex(index, summarizeIndex(index)) },
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
