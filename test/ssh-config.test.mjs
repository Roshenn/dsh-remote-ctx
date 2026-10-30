/**
 * ~/.ssh/config reading: parsing, OpenSSH's first-wins rules, wildcard matches,
 * includes, and the concrete Host list the panel shows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockMatches,
  blocksOf,
  defaultIdentityFile,
  discoverHosts,
  hostPatternMatches,
  loadSshConfig,
  parseSshConfig,
  readDiscoveredHosts,
  tokenize,
} from '../lib/ssh-config.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'dsh-remote-ctx-sshcfg-'));
test.after(() => rmSync(workspace, { recursive: true, force: true }));

// A native, absolute home: the parser resolves identity paths with node:path.
const HOME = join(workspace, 'home');

const SAMPLE = `# machines on the LAN
Host lan-box
  HostName 192.168.31.200
  User ubuntu
  Port 2222

Host build, ci
  HostName build.internal
  User builder

Host *.corp
  User corp-user

Host secret
  HostName secret.internal
  ProxyJump bastion

Host wildcard-*
  HostName ignored.example

Match host x
  User ignored

Host fresh
  HostName 10.0.0.9

Host * 
  ServerAliveInterval 30
`;

test('tokenize strips comments and honours quotes', () => {
  assert.deepEqual(tokenize('  Host lan  # comment'), ['Host', 'lan']);
  assert.deepEqual(tokenize('Host "two words"'), ['Host', 'two words']);
  assert.deepEqual(tokenize('HostName host#inside.example'), ['HostName', 'host#inside.example']);
  assert.deepEqual(tokenize(''), []);
});

test('parseSshConfig keeps blocks in order with first-wins options', () => {
  const blocks = blocksOf(parseSshConfig(SAMPLE, 'config'));
  assert.deepEqual(blocks[0].patterns, ['lan-box']);
  assert.deepEqual(blocks[1].patterns, ['build', 'ci']);
  assert.equal(blocks[0].options.hostname, '192.168.31.200');
  assert.equal(blocks[0].options.port, '2222');
  // The `Match` block is skipped entirely; `fresh` still parses after it.
  assert.ok(blocks.some((block) => block.patterns.includes('fresh')));
  assert.equal(blocks.filter((block) => block.patterns.includes('x')).length, 0);
});

test('hostPatternMatches and blockMatches follow Host semantics', () => {
  assert.ok(hostPatternMatches('*.corp', 'db.corp'));
  assert.ok(hostPatternMatches('?.corp', 'a.corp'));
  assert.ok(!hostPatternMatches('?.corp', 'ab.corp'));
  assert.ok(blockMatches(['web', '*.corp'], 'api.corp'));
  assert.ok(!blockMatches(['!web', '*.corp'], 'web'));
  assert.ok(!blockMatches(['*.corp'], 'web'));
});

test('discoverHosts lists concrete aliases with effective values', () => {
  const blocks = blocksOf(parseSshConfig(SAMPLE));
  const key = join(HOME, '.ssh', 'id_ed25519');
  const entries = discoverHosts(blocks, { home: HOME, defaultIdentityFile: key });
  const aliases = entries.map((entry) => entry.alias);
  // Wildcard patterns are rules, not machines; matches are not aliases.
  assert.deepEqual(aliases, ['build', 'ci', 'fresh', 'lan-box', 'secret']);
  const lan = entries.find((entry) => entry.alias === 'lan-box');
  assert.equal(lan.hostName, '192.168.31.200');
  assert.equal(lan.user, 'ubuntu');
  assert.equal(lan.port, 2222);
  assert.equal(lan.identityFile, key);
  const ci = entries.find((entry) => entry.alias === 'ci');
  assert.equal(ci.hostName, 'build.internal');
  assert.equal(ci.port, 22);
  const fresh = entries.find((entry) => entry.alias === 'fresh');
  assert.equal(fresh.hostName, '10.0.0.9');
  assert.equal(fresh.user, undefined);
  const secret = entries.find((entry) => entry.alias === 'secret');
  assert.equal(secret.proxyJump, 'bastion');
});

test('Host * defaults apply to every alias, without listing * itself', () => {
  const blocks = blocksOf(parseSshConfig('Host *\n  User default-user\n  IdentityFile ~/.ssh/deploy_key\n\nHost box\n  HostName 1.2.3.4\n'));
  const entries = discoverHosts(blocks, { home: HOME });
  assert.deepEqual(entries.map((entry) => entry.alias), ['box']);
  assert.equal(entries[0].user, 'default-user');
  assert.equal(entries[0].identityFile, join(HOME, '.ssh', 'deploy_key'));
});

test('a later duplicate Host does not override the first', () => {
  const blocks = blocksOf(parseSshConfig('Host dup\n  HostName first.example\n\nHost dup\n  HostName second.example\n'));
  const entries = discoverHosts(blocks, { home: HOME });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hostName, 'first.example');
});

test('loadSshConfig splices Include files in place', () => {
  const dir = join(workspace, 'include');
  mkdirSync(join(dir, '.ssh'), { recursive: true });
  writeFileSync(join(dir, '.ssh', 'config'), 'Include extra\n\nHost main\n  HostName main.example\n');
  writeFileSync(join(dir, '.ssh', 'extra'), 'Host extra\n  HostName extra.example\n');
  const loaded = loadSshConfig(join(dir, '.ssh', 'config'), { home: dir });
  const aliases = discoverHosts(loaded.blocks, { home: dir }).map((entry) => entry.alias);
  assert.deepEqual(aliases, ['extra', 'main']);
  assert.equal(loaded.files.length, 2);
  assert.deepEqual(loaded.unresolvedIncludes, []);
});

test('a wildcard Include is reported rather than guessed', () => {
  const dir = join(workspace, 'wild');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config'), 'Include conf.d/*\nHost box\n  HostName 1.1.1.1\n');
  const loaded = loadSshConfig(join(dir, 'config'), { home: dir });
  assert.deepEqual(loaded.unresolvedIncludes, ['conf.d/*']);
  assert.deepEqual(discoverHosts(loaded.blocks, { home: dir }).map((entry) => entry.alias), ['box']);
});

test('a missing config yields no hosts, not an error', () => {
  const discovered = readDiscoveredHosts(join(workspace, 'nope', 'config'), { home: workspace });
  assert.equal(discovered.missing, true);
  assert.deepEqual(discovered.entries, []);
});

test('the real fixture shape resolves user, port and key', () => {
  const file = join(workspace, 'real-config');
  writeFileSync(file, [
    'Host vm-ubuntu-server-lan',
    '    HostName 192.168.31.200',
    '    User ubuntu',
    '',
    'Host freqUI-dev',
    '    HostName 192.168.31.200',
    '    User ftuser',
    '    Port 2222',
  ].join('\n'));
  const discovered = readDiscoveredHosts(file, { home: workspace, defaultIdentityFile: undefined });
  assert.deepEqual(discovered.entries.map((entry) => `${entry.alias}:${entry.user}:${entry.port}`), [
    'freqUI-dev:ftuser:2222',
    'vm-ubuntu-server-lan:ubuntu:22',
  ]);
});

test('defaultIdentityFile only reports a key that exists', () => {
  assert.equal(defaultIdentityFile(HOME, (path) => path.endsWith('id_ed25519')), join(HOME, '.ssh', 'id_ed25519'));
  assert.equal(defaultIdentityFile(HOME, () => false), undefined);
});
