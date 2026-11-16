import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS, resolveSettings, withSettingValue,
} from '../packages/shared/dist/config/core/settings.js';
import { YamlSettingsStore } from '../packages/shared/dist/config/adapters/yaml-store.js';
import { renderCliResult } from '../packages/shared/dist/cli/adapters/renderer.js';

test('Shared owns BRC and Agent settings with validated overrides', () => {
  assert.equal(DEFAULT_SETTINGS.agent.fileReadLineLimit, 1000);
  assert.equal(DEFAULT_SETTINGS.agent.fileWriteLineLimit, 50);
  assert.equal(DEFAULT_SETTINGS.agent.telemetry.enabled, false);
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
    code: 'NOT_FOUND', exit_code: 4, message: 'Missing', run: 'brc status', retryable: false,
  });
});
