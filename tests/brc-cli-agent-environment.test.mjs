import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';

const traefikBinary = process.env.BRC_TRAEFIK_TEST_BINARY;
const realTraefikSkip = traefikBinary ? false : 'Set BRC_TRAEFIK_TEST_BINARY to an official Traefik v3.7+ executable.';

async function reservePorts(count) {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < count) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to allocate loopback port.');
      if (ports.includes(address.port)) {
        await new Promise((resolve) => server.close(resolve));
        continue;
      }
      servers.push(server);
      ports.push(address.port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
  return ports;
}

test('managed Agent receives the canonical BRC data and config paths', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const agent = createDefaultServices(paths, DEFAULT_SETTINGS, { BRC_DATA_ROOT: root })
    .find((service) => service.name === 'agent');
  assert.ok(agent);
  assert.equal(agent.env.BRC_DATA_ROOT, paths.root);
  assert.equal(agent.env.BRC_CONFIG_FILE, path.join(paths.config, 'brc.yaml'));
  assert.equal(Object.hasOwn(agent.env, 'BRC_HOME'), false);
});

test('managed Agent service spec starts connect mode and accepts --brc-managed-id', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-spec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const agent = createDefaultServices(paths, DEFAULT_SETTINGS, { BRC_DATA_ROOT: root })
    .find((service) => service.name === 'agent');
  assert.ok(agent);
  assert.deepEqual(agent.args, ['connect']);
  const result = spawnSync(
    process.execPath,
    [agent.entrypoint, ...(agent.args ?? []), '--brc-managed-id=11111111-2222-3333-4444-555555555555', '--preview', '--json'],
    { cwd: agent.cwd, env: agent.env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'connect');
});

test('brc start boots relay, traefik, and agent into managed status cleanly', { skip: realTraefikSkip, timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'brc-start-e2e-'));
  const cliEntry = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
  const relayEntry = fileURLToPath(new URL('../packages/relay/dist/cli.js', import.meta.url));
  const [relayPort, proxyPort, healthPort] = await reservePorts(3);
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const env = {
    ...baseEnv,
    BRC_DATA_ROOT: root,
    BRC_NO_BROWSER: '1',
    BRC_RELAY_PORT: String(relayPort),
    BRC_TRAEFIK_PORT: String(proxyPort),
    BRC_TRAEFIK_HEALTH_PORT: String(healthPort),
    BRC_DB: path.join(root, 'data', 'relay.sqlite'),
  };
  const run = (entry, args, input = '') => spawnSync(process.execPath, [entry, ...args], {
    env, input, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  t.after(() => {
    run(cliEntry, ['stop']);
    rmSync(root, { recursive: true, force: true });
  });

  const versionResult = spawnSync(traefikBinary, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const version = versionResult.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, versionResult.stdout);

  mkdirSync(path.join(root, 'traefik', 'versions', version), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  copyFileSync(traefikBinary, path.join(root, 'traefik', 'versions', version, process.platform === 'win32' ? 'traefik.exe' : 'traefik'));
  writeFileSync(path.join(root, 'traefik', 'versions.json'), JSON.stringify({ version: 1, current: version, previous: null }));

  const init = run(relayEntry, ['--initialize'], JSON.stringify({ username: 'admin', password: 'brc-test-password-123' }));
  assert.equal(init.status, 0, init.stderr);
  const setup = run(cliEntry, ['setup']);
  assert.equal(setup.status, 0, setup.stderr);
  const started = run(cliEntry, ['start']);
  assert.equal(started.status, 0, started.stderr);
  const status = run(cliEntry, ['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /relay: running/);
  assert.match(status.stdout, /traefik: running/);
  assert.match(status.stdout, /agent: (?:running|pairing)/);
  const stopped = run(cliEntry, ['stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
});
