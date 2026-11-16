import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { AgentConfigManager } from '../packages/agent/dist/adapters/storage/config-manager.js';
import { resolveAgentPaths } from '../packages/agent/dist/adapters/storage/agent-paths.js';
import { ConfigStorage } from '../packages/agent/dist/adapters/storage/config-storage.js';
import { BRC_SETTING_KEYS, FileSettingsLock, YamlSettingsStore, resolveSettings } from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function isolated(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { BRC_DATA_ROOT: root };
  const paths = resolveAgentPaths(env);
  const settingsStore = new YamlSettingsStore({
    filename: paths.configFile,
    codec: { parse: (data) => yaml.safeLoad(data), stringify: (data) => yaml.safeDump(data, { noRefs: true }) },
    lock: new FileSettingsLock(path.dirname(paths.configFile)),
    backupFilename: paths.configFile + '.last-good',
    backupKeys: BRC_SETTING_KEYS.filter((key) => key.startsWith('agent.')),
  });
  const manager = new AgentConfigManager(
    settingsStore,
    new ConfigStorage(path.join(paths.historyDirectory, 'state.json')),
    new ConfigStorage(paths.usageFile),
    { paths, env, legacyDirectory: path.join(root, 'legacy') },
  );
  return { manager, root, paths };
}

test('new Agent reads Shared defaults and only writes canonical YAML on mutations', async (t) => {
  const { manager, root, paths } = isolated(t);
  assert.equal(await manager.getValue('fileReadLineLimit'), 1000);
  assert.equal(existsSync(paths.configFile), false);
  await manager.setUserSetting('allowedDirectories', [path.join(root, 'safe')]);
  assert.deepEqual(await manager.getValue('allowedDirectories'), [path.join(root, 'safe')]);
  const document = yaml.safeLoad(readFileSync(paths.configFile, 'utf8'));
  assert.deepEqual(resolveSettings(document, {}).fileSettings.agent.allowedDirectories, [path.join(root, 'safe')]);
  assert.equal(existsSync(path.join(root, 'config.json')), false);
});

test('internal Agent state stays outside user settings YAML', async (t) => {
  const { manager, paths } = isolated(t);
  await manager.setValue('feedbackGiven', true);
  assert.equal(await manager.getValue('feedbackGiven'), true);
  const state = JSON.parse(readFileSync(path.join(paths.historyDirectory, 'state.json'), 'utf8'));
  assert.equal(state.feedbackGiven, true);
  assert.equal(existsSync(paths.configFile), false);
});

test('concurrent setting writes preserve both values', async (t) => {
  const { manager, paths } = isolated(t);
  await Promise.all([manager.setValue('fileReadLineLimit', 111), manager.setValue('fileWriteLineLimit', 22)]);
  const config = resolveSettings(yaml.safeLoad(readFileSync(paths.configFile, 'utf8')), {});
  assert.equal(config.fileSettings.agent.fileReadLineLimit, 111);
  assert.equal(config.fileSettings.agent.fileWriteLineLimit, 22);
});

test('invalid existing YAML remains unchanged on attempted update', async (t) => {
  const { manager, paths } = isolated(t);
  mkdirSync(path.dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, 'version: 1\nagent: [broken]\n');
  const original = readFileSync(paths.configFile, 'utf8');
  await assert.rejects(manager.setValue('allowedDirectories', ['a']));
  assert.equal(readFileSync(paths.configFile, 'utf8'), original);
});

test('migration preserves explicit YAML settings while importing missing legacy values', async (t) => {
  const { manager, paths, root } = isolated(t);
  const legacy = path.join(root, 'legacy');
  mkdirSync(legacy);
  mkdirSync(path.dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, yaml.safeDump({ version: 1, agent: { allowedDirectories: ['new'] } }));
  writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({
    allowedDirectories: ['old'], fileReadLineLimit: 89, feedbackGiven: true,
  }));
  await manager.init();
  assert.deepEqual(await manager.getValue('allowedDirectories'), ['new']);
  assert.equal(await manager.getValue('fileReadLineLimit'), 89);
  assert.equal(await manager.getValue('feedbackGiven'), true);
  assert.equal(existsSync(path.join(legacy, 'config.json')), false);
});


test('aggregate tool usage has a dedicated data file rather than leaking into settings or state', async (t) => {
  const { manager, paths } = isolated(t);
  await manager.setValue('usageStats', { totalToolCalls: 7, successfulCalls: 5 });
  assert.deepEqual(await manager.getValue('usageStats'), { totalToolCalls: 7, successfulCalls: 5 });
  assert.equal(existsSync(paths.usageFile), true);
  assert.deepEqual(JSON.parse(readFileSync(paths.usageFile, 'utf8')).usageStats, {
    totalToolCalls: 7, successfulCalls: 5,
  });
  assert.equal(existsSync(paths.configFile), false);
  const state = path.join(paths.historyDirectory, 'state.json');
  if (existsSync(state)) assert.equal(JSON.parse(readFileSync(state, 'utf8')).usageStats, undefined);
});
