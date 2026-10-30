/**
 * Offline smoke check: prints the resolved configuration, the registered tool
 * list, and the connection records that would be used — without opening a
 * network connection. Run it after installing to confirm the host half loaded
 * with the config you think it did.
 */
import { resolveConfig } from '../lib/config.mjs';
import { RemoteContext } from '../lib/context.mjs';

const config = resolveConfig({});
const context = new RemoteContext(config);
const connections = context.listConnections();

console.log('dsh-remote-ctx smoke');
console.log('  connections file:', config.connectionsFile);
console.log('  index dir:       ', config.indexDir);
console.log('  read limit:      ', config.maxReadBytes, 'bytes');
console.log('  remote write:    ', config.allowRemoteWrite ? 'enabled' : 'disabled');
console.log('  connections:     ', connections.length);
for (const connection of connections) {
  const auth = connection.auth.kind === 'key' ? `key ${connection.auth.privateKeyPath}` : connection.auth.kind;
  console.log(`    - ${connection.id}: ${connection.host}:${connection.port} -> ${connection.remoteRoot} (${auth})`);
}

try {
  const plugin = await import('../lib/index.js');
  console.log('  tools:           ', plugin.name, '| inject', JSON.stringify(plugin.inject));
} catch (error) {
  console.log('  tools:            not loadable here —', error.code === 'ERR_MODULE_NOT_FOUND'
    ? 'run inside dsh, or install the peer dependency @deepseek-ai/dsh-tools'
    : error.message);
}
