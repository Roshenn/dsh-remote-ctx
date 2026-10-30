/**
 * Markdown rendering for tool results.
 *
 * Every tool answers with the same envelope — `text` plus typed fields — so the
 * model gets a readable table and the transcript renderer gets a stable shape.
 * Tables are narrow on purpose: a model reads these, not a browser.
 */

const MAX_ROWS = 200;

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatConnection(connection, state) {
  const auth = connection.auth?.kind === 'key'
    ? `key ${connection.auth.privateKeyPath ?? ''}`.trim()
    : connection.auth?.kind === 'password' ? 'password' : 'agent';
  const status = state?.connected ? 'connected' : state?.error ? 'error' : 'idle';
  return `| ${connection.id} | ${connection.label} | ${connection.username ? `${connection.username}@` : ''}${connection.host}:${connection.port} | ${connection.remoteRoot} | ${auth} | ${status} |`;
}

export function formatConnections(connections, states = {}) {
  if (!connections.length) {
    return [
      '**remote-ctx** · no connections yet',
      '',
      'Add one with `remote_ctx_connections` (action: "add"), or in the sidebar: **Remote context → Add connection**.',
    ].join('\n');
  }
  const lines = [
    `**remote-ctx** · ${connections.length} connection${connections.length === 1 ? '' : 's'}`,
    '',
    '| id | label | target | remote root | auth | state |',
    '| --- | --- | --- | --- | --- | --- |',
    ...connections.slice(0, MAX_ROWS).map((connection) => formatConnection(connection, states[connection.id])),
  ];
  return lines.join('\n');
}

export function formatListing(listing, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.min(options.limit, MAX_ROWS) : MAX_ROWS;
  if (!listing.entries.length) {
    return `**remote_ctx_ls** \`${listing.path}\` — empty directory`;
  }
  const shown = listing.entries.slice(0, limit);
  const dirs = listing.entries.filter((entry) => entry.type === 'dir').length;
  const lines = [
    `**remote_ctx_ls** \`${listing.path}\` · ${listing.entries.length} entries (${dirs} director${dirs === 1 ? 'y' : 'ies'})`,
    '',
    '| type | name | size | modified |',
    '| --- | --- | --- | --- |',
    ...shown.map((entry) => `| ${entry.type === 'dir' ? 'dir' : entry.type === 'link' ? 'link' : 'file'} | ${entry.name} | ${entry.type === 'file' ? formatBytes(entry.size) : '—'} | ${entry.mtimeMs ? new Date(entry.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') : '—'} |`),
  ];
  if (listing.entries.length > shown.length) {
    lines.push('', `_… ${listing.entries.length - shown.length} more entries not shown (raise \`limit\`)._`);
  }
  return lines.join('\n');
}

export function formatRead(result) {
  const header = `**remote_ctx_read** \`${result.path}\` · ${formatBytes(result.bytes)}${result.truncated ? ' · truncated' : ''}`;
  const body = result.text.length > 12000 ? `${result.text.slice(0, 12000)}\n\n_… output truncated at 12000 characters; pass a higher limit or read a narrower path._` : result.text;
  return `${header}\n\n\`\`\`\n${body}\n\`\`\``;
}

export function formatWrite(result) {
  return `**remote_ctx_write** \`${result.path}\` · wrote ${formatBytes(result.bytes)} (atomic: temp file + rename)`;
}

export function formatIndex(index, summary) {
  const lines = [
    `**remote_ctx_index** \`${index.root}\` · ${summary.files} files, ${summary.dirs} dirs, ${formatBytes(summary.bytes)}`,
    `built ${index.builtAt}${summary.truncated ? ' · **truncated** (raise maxIndexFiles / maxIndexDepth)' : ''}`,
  ];
  if (index.errors?.length) {
    lines.push('', `_${index.errors.length} directories could not be listed; first: ${index.errors[0].path} — ${index.errors[0].message}_`);
  }
  return lines.join('\n');
}

export function formatSearch(mode, result, options = {}) {
  if (mode === 'content') {
    if (!result.hits.length) {
      return `**remote_ctx_find** \`${options.query}\` · content · no matches (${result.filesScanned} files scanned)`;
    }
    const lines = [
      `**remote_ctx_find** \`${options.query}\` · content · ${result.hits.length} hit${result.hits.length === 1 ? '' : 's'} in ${result.filesScanned} files`,
      '',
      '| file | line | text |',
      '| --- | --- | --- |',
      ...result.hits.slice(0, 100).map((hit) => `| ${hit.path} | ${hit.line} | ${escapeCell(hit.text)} |`),
    ];
    if (result.truncated) lines.push('', '_… truncated; narrow the query or raise the limit._');
    return lines.join('\n');
  }
  if (!result.entries.length) {
    return `**remote_ctx_find** \`${options.query ?? '*'}\` · ${mode} · no matches in the cached index`;
  }
  return [
    `**remote_ctx_find** \`${options.query ?? '*'}\` · ${mode} · ${result.total} match${result.total === 1 ? '' : 'es'}`,
    '',
    '| path | type | size |',
    '| --- | --- | --- |',
    ...result.entries.slice(0, 200).map((entry) => `| ${entry.path} | ${entry.type} | ${entry.type === 'file' ? formatBytes(entry.size) : '—'} |`),
  ].join('\n');
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function formatSync(plan, applied, options = {}) {
  const dryRun = options.dryRun === true;
  const verb = plan.direction === 'push' ? 'upload' : 'download';
  const pending = plan.direction === 'push' ? plan.uploads : plan.downloads;
  const lines = [
    `**remote_ctx_sync** · ${plan.direction} · ${pending.length} ${verb}${pending.length === 1 ? '' : 's'}, ${plan.skipped.length} unchanged, ${formatBytes(plan.bytes)}`
      + `${dryRun ? ' · **dry run**, nothing written' : ''}`,
  ];
  if (plan.truncated) lines.push('', '_the source listing was truncated at `maxIndexFiles`; run again with a narrower root._');
  if (pending.length) {
    lines.push('', '| file | reason | size |', '| --- | --- | --- |');
    for (const row of pending.slice(0, 100)) {
      lines.push(`| ${row.path} | ${row.reason} | ${formatBytes(row.size)} |`);
    }
    if (pending.length > 100) lines.push('', `_… ${pending.length - 100} more files not listed._`);
  }
  if (applied) {
    lines.push('', applied.failed.length
      ? `**${applied.failed.length} failed**, ${applied.ok.length} ok — first: \`${applied.failed[0].path}\` ${applied.failed[0].error}`
      : `all ${applied.ok.length} ${verb}s ok (${formatBytes(applied.bytes)})`);
  }
  return lines.join('\n');
}
