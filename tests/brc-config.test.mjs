import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { DEFAULT_SETTINGS as SHARED_DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { LifecycleLock } from '../packages/cli/dist/adapters/storage/lock.js';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { loadConfig } from '../packages/relay/dist/adapters/http/app.js';
import { runConfigCommand } from '../packages/cli/dist/commands/config.js';

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-config-test-'));
  const env = { ...options.env, BRC_DATA_ROOT: root };
  const paths = resolveBrcPaths(env);
  await mkdir(paths.config, { recursive: true });
  const lock = new LifecycleLock(paths);
  const apply = options.apply ?? (async () => { });
  const manager = await SettingsManager.load(paths, env, { lock, apply });
  return { env, paths, lock, apply, manager };
}

function commandDependencies(manager, paths, output) {
  return { manager, paths };
}

test('central settings defaults match the public configuration contract', () => {
  const { agent, ...settings } = DEFAULT_SETTINGS;
  assert.deepEqual(settings, {
    version: 1,
    proxy: {
      rate: { average: 10, period: '1s', burst: 30 },
      concurrent: 16,
    },
    services: {
      relayPort: 3000,
      proxyPort: 13001,
      healthPort: 13002,
      publicUrl: '',
    },
    logs: {
      retentionDays: 7,
      maxTotalMiB: 50,
      rotateMiB: 4,
    },
    diagnostics: {
      enabled: true,
      resourceSampleMs: 1000,
      functionSnapshotMs: 10000,
      maxRecordBytes: 65536,
      retentionDays: 7,
    },
    audit: {
      retentionDays: 30,
      maxEntries: 50_000,
    },
    runtime: {
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 3_000,
      lockWaitMs: 3_000,
      lockPollMs: 50,
    },
  });
  assert.equal(agent.fileReadLineLimit, 1_000);
  assert.equal(agent.fileWriteLineLimit, 50);
  assert.equal(agent.commandTimeoutMs, 1_000);
  assert.equal(agent.telemetry.enabled, false);
  assert.ok(agent.blockedCommands.length > 0);
  assert.deepEqual(agent.allowedDirectories, []);
});

test('settings snapshots are independent of manager state and each other', async (t) => {
  const { manager } = await createFixture(t);
  const first = manager.snapshot();
  const second = manager.snapshot();
  first.proxy.rate.average = 999;
  first.services.relayPort = 9999;
  first.logs.retentionDays = 1;
  first.runtime.startupTimeoutMs = 1;
  assert.equal(manager.get('proxy.rate.average').value, 10);
  assert.equal(manager.get('services.relayPort').value, 3000);
  assert.equal(manager.get('logs.retentionDays').value, 7);
  assert.equal(manager.get('runtime.startupTimeoutMs').value, 15_000);
  assert.equal(second.proxy.rate.average, 10);
  assert.equal(manager.snapshot().proxy.rate.average, 10);
});

test('public URL setting persists, validates origins and marks restart required', async (t) => {
  const { manager, paths, env, lock, apply } = await createFixture(t);
  assert.deepEqual(manager.get('services.publicUrl'), { value: '', source: 'default' });
  const origin = 'https://brc.example.com';
  const result = await manager.set('services.publicUrl', origin);
  assert.equal(result.restartRequired, true);
  const disk = await readFile(path.join(paths.config, 'brc.yaml'), 'utf8');
  assert.match(disk, /publicUrl: ['"]?https:\/\/brc\.example\.com['"]?/);
  const next = await SettingsManager.load(paths, env, { lock, apply });
  assert.deepEqual(next.get('services.publicUrl'), { value: origin, source: 'file' });
  for (const invalid of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://brc.example.com/path', 'https://brc.example.com/?x=1', 'https://brc.example.com/#x', 'https://brc.example.com?', 'https://brc.example.com#']) {
    await assert.rejects(next.set('services.publicUrl', invalid), /services\.publicUrl/);
  }
  assert.deepEqual(next.get('services.publicUrl'), { value: origin, source: 'file' });
});

test('Relay uses persisted public URL across separate CLI service constructions', async (t) => {
  const { manager, paths, env, lock, apply } = await createFixture(t);
  const origin = 'https://brc.example.com';
  await manager.set('services.publicUrl', origin);
  const next = await SettingsManager.load(paths, env, { lock, apply });
  const parentEnv = { PUBLIC_URL: 'https://stale-env.example.com' };
  const first = createDefaultServices(paths, next.snapshot(), parentEnv).find((service) => service.name === 'relay');
  const second = createDefaultServices(paths, next.snapshot(), {}).find((service) => service.name === 'relay');
  assert.equal(first.env.PUBLIC_URL, origin);
  assert.equal(second.env.PUBLIC_URL, origin);
  const defaultService = createDefaultServices(paths, DEFAULT_SETTINGS, parentEnv).find((service) => service.name === 'relay');
  assert.equal(defaultService.env.PUBLIC_URL, 'http://127.0.0.1:13001');
  assert.equal(first.env.HOST, '127.0.0.1');
  assert.equal(first.env.BRC_ADMIN_PASSWORD, undefined);
  assert.equal(first.env.BRC_SESSION_SECRET, undefined);
});

test('public URL environment override and CLI clear preserve configuration semantics', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  await manager.set('services.publicUrl', 'https://saved.example.com');
  const override = await SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_PUBLIC_URL: 'https://override.example.com',
  }, { lock, apply });
  assert.deepEqual(override.get('services.publicUrl'), {
    value: 'https://override.example.com', source: 'environment',
  });

  const output = [];
  const result = await runConfigCommand(['set', 'services.publicUrl', ''], commandDependencies(manager, paths, output));
  assert.equal(result.status, 'success');
  assert.equal(result.data.restartRequired, true);
  assert.deepEqual(manager.get('services.publicUrl'), { value: '', source: 'file' });
});

test('missing configuration uses defaults and reports default sources', async (t) => {
  const { manager, paths } = await createFixture(t);

  assert.deepEqual(manager.get('proxy.rate.average'), { value: 10, source: 'default' });
  await assert.rejects(readFile(path.join(paths.config, 'brc.yaml'), 'utf8'), { code: 'ENOENT' });
});

test('registered environment values override file values and defaults', async (t) => {
  const { paths, lock, apply } = await createFixture(t);
  const filename = path.join(paths.config, 'brc.yaml');
  await writeFile(filename, 'version: 1\nproxy:\n  rate:\n    average: 18\n');
  const manager = await SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_PROXY_RATE_AVERAGE: '24',
  }, { lock, apply });

  assert.deepEqual(manager.get('proxy.rate.average'), { value: 24, source: 'environment' });
  assert.deepEqual(manager.get('proxy.rate.burst'), { value: 30, source: 'default' });
});
test('audit policy defaults and environment overrides reach Relay', async (t) => {
  const { paths, lock, apply } = await createFixture(t);
  const manager = await SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_AUDIT_RETENTION_DAYS: '90',
    BRC_AUDIT_MAX_ENTRIES: '1200',
  }, { lock, apply });

  assert.deepEqual(manager.get('audit.retentionDays'), { value: 90, source: 'environment' });
  assert.deepEqual(manager.get('audit.maxEntries'), { value: 1200, source: 'environment' });
  assert.equal(DEFAULT_SETTINGS.audit.retentionDays, 30);
  assert.equal(DEFAULT_SETTINGS.audit.maxEntries, 50_000);

  const relay = createDefaultServices(paths, manager.snapshot(), {}).find((service) => service.name === 'relay');
  assert.equal(relay.env.BRC_AUDIT_RETENTION_DAYS, '90');
  assert.equal(relay.env.BRC_AUDIT_MAX_ENTRIES, '1200');
  assert.deepEqual(loadConfig(relay.env).audit, { retentionDays: 90, maxEntries: 1200 });
});

test('audit policy accepts boundaries and rejects values outside its range', async (t) => {
  const { paths, lock, apply } = await createFixture(t);

  for (const maxEntries of ['1', '50000']) {
    await assert.doesNotReject(SettingsManager.load(paths, {
      BRC_DATA_ROOT: paths.root,
      BRC_AUDIT_MAX_ENTRIES: maxEntries,
    }, { lock, apply }));
  }
  for (const maxEntries of ['0', '50001']) {
    await assert.rejects(SettingsManager.load(paths, {
      BRC_DATA_ROOT: paths.root,
      BRC_AUDIT_MAX_ENTRIES: maxEntries,
    }, { lock, apply }), /audit\.maxEntries|BRC_AUDIT_MAX_ENTRIES/i);
  }
  await assert.rejects(SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_AUDIT_RETENTION_DAYS: '-1',
  }, { lock, apply }), /audit\.retentionDays|BRC_AUDIT_RETENTION_DAYS/i);
});

test('file values override defaults and report file sources', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nproxy:\n  rate:\n    average: 18\n');
  const configured = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  assert.deepEqual(configured.get('proxy.rate.average'), { value: 18, source: 'file' });
  assert.deepEqual(configured.get('proxy.rate.period'), { value: '1s', source: 'default' });
  assert.equal(manager.get('proxy.rate.average').value, 10);
});

test('unknown configuration keys are rejected', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nproxy:\n  unknown: true\n');

  await assert.rejects(manager.apply(), /unknown/i);
});

test('invalid YAML is rejected', async (t) => {
  const { paths, env, lock, apply } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: [');
  const reloaded = await SettingsManager.load(paths, env, { lock, apply });

  await assert.rejects(reloaded.apply(), /yaml/i);
});

test('out-of-range numbers are rejected', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 70000\n');

  await assert.rejects(manager.apply(), /relayPort|port|range/i);
});

test('configuration files require version 1', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'proxy:\n  rate:\n    average: 12\n');

  await assert.rejects(manager.apply(), /version/i);
});

test('environment values use the same validation as file values', async (t) => {
  const { paths, lock, apply } = await createFixture(t);

  await assert.rejects(
    SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root, BRC_PROXY_RATE_AVERAGE: 'fast' }, { lock, apply }),
    /BRC_PROXY_RATE_AVERAGE|average|number/i,
  );
});

test('service ports must remain distinct', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 13001\n  proxyPort: 13001\n');

  await assert.rejects(manager.apply(), /different|distinct|port/i);
});

test('config path prints the selected configuration file', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['path'], commandDependencies(manager, paths, output));

  assert.equal(result.status, 'success');
  assert.equal(result.data.path, path.join(paths.config, 'brc.yaml'));
});

test('config get reports value and source', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['get', 'proxy.rate.average'], commandDependencies(manager, paths, output));

  assert.equal(result.status, 'success');
  assert.deepEqual(result.data, { key: 'proxy.rate.average', value: 10, source: 'default' });
});

test('config show reports all effective values and sources', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['show'], commandDependencies(manager, paths, output));
  const text = JSON.stringify(result.data);

  assert.equal(result.status, 'success');
  assert.match(text, /proxy\.rate\.average/);
  assert.match(text, /10/);
  assert.match(text, /default/);
  assert.match(text, /services\.relayPort/);
});

test('config set applies valid values and flags static service changes for restart', async (t) => {
  let appliedRelayPort = 0;
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => { appliedRelayPort = settings.services.relayPort; },
  });
  const output = [];

  const result = await runConfigCommand(['set', 'services.relayPort', '3100'], commandDependencies(manager, paths, output));

  assert.equal(result.status, 'success');
  assert.equal(manager.get('services.relayPort').value, 3100);
  assert.equal(appliedRelayPort, 3100);
  assert.equal(result.data.restartRequired, true);
});

test('config apply loads and applies user-edited configuration', async (t) => {
  let appliedRelayPort = 0;
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => { appliedRelayPort = settings.services.relayPort; },
  });
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 3100\n');
  const output = [];

  const result = await runConfigCommand(['apply'], commandDependencies(manager, paths, output));

  assert.equal(result.status, 'success');
  assert.equal(manager.get('services.relayPort').value, 3100);
  assert.equal(appliedRelayPort, 3100);
});

test('failed config application restores the last valid file and settings', async (t) => {
  const appliedPorts = [];
  const { manager, paths, env, apply } = await createFixture(t, {
    apply: async (settings, previous) => {
      appliedPorts.push([settings.services.relayPort, previous.services.relayPort]);
      if (settings.services.relayPort === 3100) throw new Error('apply failed');
    },
  });
  await manager.set('services.relayPort', 3001);
  const filename = path.join(paths.config, 'brc.yaml');
  const lastValidFile = await readFile(filename, 'utf8');
  await writeFile(filename, 'version: 1\nservices:\n  relayPort: 3100\n');
  const reloaded = await SettingsManager.load(paths, env, { lock: new LifecycleLock(paths), apply });

  await assert.rejects(reloaded.apply(), /apply failed/);

  assert.equal(reloaded.get('services.relayPort').value, 3001);
  assert.equal(await readFile(filename, 'utf8'), lastValidFile);
  assert.equal(await readFile(path.join(paths.config, 'brc.yaml.last-good'), 'utf8'), lastValidFile);
  assert.deepEqual(appliedPorts, [[3001, 3000], [3100, 3001], [3001, 3001]]);
});

test('rollback preserves the exact last-good YAML text', async (t) => {
  const { paths, env, lock } = await createFixture(t);
  const filename = path.join(paths.config, 'brc.yaml');
  const original = '# keep this comment\nversion: 1\nservices:\n  relayPort: 3001\n';
  await writeFile(filename, original);
  const manager = await SettingsManager.load(paths, env, {
    lock,
    apply: async (settings) => {
      if (settings.services.relayPort === 3100) throw new Error('apply failed');
    },
  });
  await writeFile(filename, 'version: 1\nservices:\n  relayPort: 3100\n');
  await assert.rejects(manager.apply(), /apply failed/);
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.equal(await readFile(filename + '.last-good', 'utf8'), original);
});

test('invalid environment overrides do not replace valid configuration with last-good', async (t) => {
  const { paths, lock } = await createFixture(t);
  const filename = path.join(paths.config, 'brc.yaml');
  const contents = '# user configuration\nversion: 1\n';
  await writeFile(filename, contents);
  await assert.rejects(
    SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root, BRC_RELAY_PORT: 'invalid' }, {
      lock,
      apply: async () => {},
    }),
    /Invalid environment configuration/,
  );
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('failed first config write removes new file and preserves defaults', async (t) => {
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => {
      if (settings.services.relayPort === 3100) throw new Error('apply failed');
    },
  });
  const filename = path.join(paths.config, 'brc.yaml');

  await assert.rejects(manager.set('services.relayPort', 3100), /apply failed/);

  assert.equal(manager.get('services.relayPort').value, 3000);
  await assert.rejects(readFile(filename, 'utf8'), { code: 'ENOENT' });
});

test('concurrent setting changes preserve both values on disk', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  const secondManager = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  await Promise.all([
    manager.set('proxy.rate.average', 20),
    secondManager.set('proxy.rate.burst', 40),
  ]);
  const persisted = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  assert.equal(persisted.get('proxy.rate.average').value, 20);
  assert.equal(persisted.get('proxy.rate.burst').value, 40);
});
test('setup initializes missing settings and records the last-good configuration', async (t) => {
  const { manager, paths } = await createFixture(t);

  await manager.ensureConfigFile();

  const filename = path.join(paths.config, 'brc.yaml');
  const contents = await readFile(filename, 'utf8');
  assert.match(contents, /version: 1/);
  assert.equal(await readFile(path.join(paths.config, 'brc.yaml.last-good'), 'utf8'), contents);
  assert.deepEqual(manager.snapshot(), DEFAULT_SETTINGS);
});

test('diagnostic settings validate bool, bounds, provenance and service propagation', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  assert.equal(manager.get('diagnostics.enabled').value, true);
  assert.equal(manager.get('diagnostics.resourceSampleMs').value, 1000);
  assert.equal(manager.get('diagnostics.functionSnapshotMs').value, 10000);
  assert.equal(manager.get('diagnostics.maxRecordBytes').value, 65536);
  assert.equal(manager.get('diagnostics.retentionDays').value, 7);
  await manager.set('diagnostics.enabled', false);
  await manager.set('diagnostics.resourceSampleMs', 2000);
  const overridden = await SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_DIAGNOSTICS_ENABLED: 'true',
    BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS: '5000',
  }, { lock, apply });
  assert.deepEqual(overridden.get('diagnostics.enabled'), { value: true, source: 'environment' });
  assert.deepEqual(overridden.get('diagnostics.resourceSampleMs'), { value: 5000, source: 'environment' });
  const services = createDefaultServices(paths, overridden.snapshot(), { BRC_DIAGNOSTICS_ENABLED: 'false' });
  for (const service of services) {
    assert.equal(service.env.BRC_DIAGNOSTICS_ENABLED, 'true');
    assert.equal(service.env.BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS, '5000');
    assert.equal(service.env.BRC_DIAGNOSTICS_MAX_RECORD_BYTES, '65536');
  }
  for (const [key, value] of [
    ['diagnostics.resourceSampleMs', 5],
    ['diagnostics.functionSnapshotMs', 0],
    ['diagnostics.maxRecordBytes', 100],
    ['diagnostics.retentionDays', -1],
    ['diagnostics.enabled', 1],
  ]) {
    await assert.rejects(manager.set(key, value), /diagnostics/i);
  }
});

test('CLI accepts boolean diagnostic configuration values', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];
  assert.equal((await runConfigCommand(['set', 'diagnostics.enabled', 'false'], commandDependencies(manager, paths, output))).status, 'success');
  assert.equal(manager.get('diagnostics.enabled').value, false);
  assert.equal((await runConfigCommand(['set', 'diagnostics.enabled', 'true'], commandDependencies(manager, paths, output))).status, 'success');
  assert.equal(manager.get('diagnostics.enabled').value, true);
  assert.equal((await runConfigCommand(['set', 'diagnostics.enabled', '0'], commandDependencies(manager, paths, output))).status, 'success');
  assert.equal(manager.get('diagnostics.enabled').value, false);
  assert.equal((await runConfigCommand(['set', 'diagnostics.enabled', '1'], commandDependencies(manager, paths, output))).status, 'success');
  assert.equal(manager.get('diagnostics.enabled').value, true);
  await assert.rejects(
    runConfigCommand(['set', 'diagnostics.enabled', 'enabled'], commandDependencies(manager, paths, output)),
    /diagnostics.enabled/,
  );
});
