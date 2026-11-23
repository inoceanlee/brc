import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { SqliteStore } from '../packages/relay/dist/adapters/storage/sqlite.js';
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';

const cliUrl = new URL('../packages/cli/dist/cli.js', import.meta.url).href;

function temporaryRoot(t) {
  const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'brc-legacy-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

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

test('relay receives the legacy identity path only while the new database is absent', (t) => {
  const root = temporaryRoot(t);
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const legacyFile = path.join(root, 'old', 'relay.sqlite');
  const before = createDefaultServices(paths, DEFAULT_SETTINGS, { BRC_DATA_ROOT: root }, legacyFile)
    .find((service) => service.name === 'relay').env;
  assert.equal(before.BRC_LEGACY_RELAY_DB, legacyFile);
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(path.join(paths.data, 'relay.sqlite'), '');
  const after = createDefaultServices(paths, DEFAULT_SETTINGS, { BRC_DATA_ROOT: root }, legacyFile)
    .find((service) => service.name === 'relay').env;
  assert.equal(Object.hasOwn(after, 'BRC_LEGACY_RELAY_DB'), false);
});

test('an inherited BRC_LEGACY_RELAY_DB never leaks into managed service environments', (t) => {
  const root = temporaryRoot(t);
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const services = createDefaultServices(paths, DEFAULT_SETTINGS, {
    BRC_DATA_ROOT: root,
    BRC_LEGACY_RELAY_DB: 'C:/unexpected/relay.sqlite',
  });
  assert.equal(services.length, 3);
  for (const service of services) {
    assert.equal(Object.hasOwn(service.env, 'BRC_LEGACY_RELAY_DB'), false, service.name);
  }
});

test('relay initializer imports the discovered legacy identity into a fresh data root', async (t) => {
  const root = temporaryRoot(t);
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const [relayPort, proxyPort, healthPort] = await reservePorts(3);
  const settings = {
    ...DEFAULT_SETTINGS,
    services: { ...DEFAULT_SETTINGS.services, relayPort, proxyPort, healthPort },
  };
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  const legacyFile = path.join(root, 'legacy', 'relay.sqlite');
  mkdirSync(path.dirname(legacyFile), { recursive: true });
  SqliteStore.initialize(legacyFile);
  const legacy = SqliteStore.open(legacyFile);
  legacy.bootstrapAdministrator('legacy-admin', 'legacy-password');
  const user = legacy.getUserByName('legacy-admin');
  const deviceToken = legacy.issueDeviceToken('legacy-device', user.id, 'Legacy PC', 'win32');
  legacy.close();
  const auditSource = new DatabaseSync(legacyFile);
  auditSource.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT)');
  auditSource.prepare('INSERT INTO audit (ts,user_id,device_id,tool,ok,ms) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), user.id, 'legacy-device', 'read_file', 1, 4);
  auditSource.close();

  const relay = createDefaultServices(paths, settings, { BRC_DATA_ROOT: root }, legacyFile)
    .find((service) => service.name === 'relay');
  const result = spawnSync(process.execPath, [relay.entrypoint, '--initialize'], {
    cwd: relay.cwd, env: relay.env, encoding: 'utf8', input: '', timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(legacyFile), false, 'initializer removes the legacy identity after importing it');
  const imported = SqliteStore.open(path.join(paths.data, 'relay.sqlite'));
  try {
    assert.equal(imported.getAdministrator().username, 'legacy-admin');
    assert.equal(imported.getDeviceByToken(deviceToken)?.device_id, 'legacy-device');
  } finally {
    imported.close();
  }
  const diagnostics = new DatabaseSync(path.join(paths.data, 'brc-diagnostics.sqlite'));
  try {
    assert.equal(diagnostics.prepare('SELECT COUNT(*) n FROM relay_audit WHERE user_id = ?').get(user.id).n, 1);
  } finally {
    diagnostics.close();
  }
});


test('setup refuses a leftover legacy identity once the new database exists', async (t) => {
  const root = temporaryRoot(t);
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const legacyFile = path.join(root, 'old', 'relay.sqlite');
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(path.join(paths.data, 'relay.sqlite'), '');
  let setupCalls = 0;
  const errors = [];
  const { runCli } = await import(cliUrl);
  const exitCode = await runCli(['setup'], {
    paths,
    commands: { setup: async () => { setupCalls += 1; return 0; } },
    legacyCandidates: [{ kind: 'identity-database', path: legacyFile }],
    clean: async () => {},
    write: () => {},
    writeError: (message) => errors.push(message),
  });
  assert.equal(exitCode, 5);
  assert.equal(setupCalls, 0);
  assert.match(errors.join('\n'), /legacy/i);
});
