import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS,
  RESOURCE_SAMPLE_INTERVAL_MAX_MS,
  resolveSettings,
  withSettingValue,
} from '../packages/shared/dist/config/core/settings.js';
import { YamlSettingsStore } from '../packages/shared/dist/config/adapters/yaml-store.js';
import { renderCliResult } from '../packages/shared/dist/cli/adapters/renderer.js';

test('Shared owns BRC and Agent settings with validated overrides', () => {
  assert.throws(
    () => resolveSettings({ version: 1 }, { BRC_AGENT_TELEMETRY_ENABLED: 'incorrect' }),
    /BRC_AGENT_TELEMETRY_ENABLED/,
  );
  const resolved = resolveSettings({
    version: 1, agent: { fileReadLineLimit: 25, telemetry: { enabled: true } },
  }, { BRC_AGENT_FILE_READ_LINE_LIMIT: '42', DO_NOT_TRACK: '1' });
  assert.equal(resolved.fileSettings.agent.fileReadLineLimit, 25);
  assert.equal(resolved.settings.agent.fileReadLineLimit, 42);
  assert.equal(resolved.settings.agent.telemetry.enabled, false);
  assert.equal(resolved.sources['agent.fileReadLineLimit'], 'environment');
  const changed = withSettingValue(DEFAULT_SETTINGS, 'agent.fileWriteLineLimit', 150);
  assert.equal(changed.agent.fileWriteLineLimit, 150);
  assert.equal(DEFAULT_SETTINGS.agent.fileWriteLineLimit, 50);
  assert.throws(() => resolveSettings({ version: 1, agent: { allowedDirectories: 'C:/tmp' } }, {}), /allowedDirectories/);
  assert.throws(() => resolveSettings({ version: 1, agent: { fileReadLineLimit: 0 } }, {}), /fileReadLineLimit/);
});

test('Shared YAML store supports revision-checked atomic updates', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-shared-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'config', 'brc.yaml');
  const codec = { parse: JSON.parse, stringify: JSON.stringify };
  const lock = { runExclusive: async (task) => task() };
  const store = new YamlSettingsStore({ filename, codec, lock });
  const initial = await store.read();
  assert.equal(initial.settings.agent.fileReadLineLimit, 1000);
  await store.write(withSettingValue(initial.settings, 'agent.fileReadLineLimit', 77), initial.revision);
  const current = await store.read();
  assert.equal(current.settings.agent.fileReadLineLimit, 77);
  await assert.rejects(store.write(DEFAULT_SETTINGS, initial.revision), /conflict|revision/i);
  const updated = await store.update((value) => withSettingValue(value, 'agent.fileWriteLineLimit', 88));
  assert.equal(updated.settings.agent.fileWriteLineLimit, 88);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).agent.fileWriteLineLimit, 88);
});

test('settings watcher can attach before the first configuration file is created', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-watch-before-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new YamlSettingsStore({
    filename: path.join(dir, 'config', 'brc.yaml'),
    codec: { parse: JSON.parse, stringify: JSON.stringify },
    lock: { runExclusive: async (task) => task() },
  });
  const stop = store.watch(() => undefined);
  stop();
});

test('Shared renderer separates machine data and machine errors', () => {
  const stdout = [];
  const stderr = [];
  const streams = { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) };
  const successCode = renderCliResult({ status: 'success', data: { running: true } }, { format: 'json' }, streams);
  assert.equal(successCode, 0);
  assert.deepEqual(JSON.parse(stdout.join('')), { running: true });
  assert.deepEqual(stderr, []);
  stdout.length = 0;
  const failureCode = renderCliResult({
    status: 'error', error: { code: 'NOT_FOUND', exitCode: 4, message: 'Missing',
      run: 'brc status', retryable: false },
  }, { format: 'json' }, streams);
  assert.equal(failureCode, 4);
  assert.deepEqual(stdout, []);
  assert.deepEqual(JSON.parse(stderr.join('')), {
    error: { code: 'NOT_FOUND', exit_code: 4, message: 'Missing', run: 'brc status', retryable: false },
  });
});

test('Shared renderer formats records as a table and leaves plain mode headerless', () => {
  const records = [{ name: 'relay', state: 'running' }, { name: 'agent', state: 'stopped' }];
  const out = [];
  const streams = { stdout: (text) => out.push(text), stderr: () => undefined };
  renderCliResult({ status: 'success', data: records }, { format: 'table' }, streams);
  assert.match(out.join(''), /^name\s+state\nrelay\s+running\nagent\s+stopped\n$/);
  out.length = 0;
  renderCliResult({ status: 'success', data: records }, { format: 'plain' }, streams);
  assert.doesNotMatch(out.join(''), /^name\s+state/);
});

test('sampling interval bounds come from the configuration model', () => {
  assert.throws(
    () => resolveSettings({ version: 1, diagnostics: { resourceSampleMs: 99 } }, {}),
    /between 100 and 60000/,
  );
  assert.throws(
    () => resolveSettings({ version: 1, diagnostics: { resourceSampleMs: 60_001 } }, {}),
    /between 100 and 60000/,
  );
  const resolved = resolveSettings({
    version: 1, diagnostics: { resourceSampleMs: RESOURCE_SAMPLE_INTERVAL_MAX_MS },
  }, {});
  assert.equal(resolved.fileSettings.diagnostics.resourceSampleMs, RESOURCE_SAMPLE_INTERVAL_MAX_MS);
});

test('last-good checkpoint recovers settings after the primary file is damaged', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-shared-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'config', 'brc.yaml');
  const backupFilename = filename + '.last-good';
  const codec = { parse: JSON.parse, stringify: JSON.stringify };
  const store = new YamlSettingsStore({
    filename, codec, lock: { runExclusive: async (task) => task() },
    backupFilename, backupKeys: ['agent.fileReadLineLimit'],
  });
  const initial = await store.read();
  await store.write(withSettingValue(initial.settings, 'agent.fileReadLineLimit', 64), initial.revision);
  const backup = JSON.parse(await readFile(backupFilename, 'utf8'));
  assert.equal(backup.agent.fileReadLineLimit, 64);
  await writeFile(filename, '{ damaged', 'utf8');
  const recovered = await store.read();
  assert.equal(recovered.settings.agent.fileReadLineLimit, 64);
  assert.equal(recovered.revision, null);
});
