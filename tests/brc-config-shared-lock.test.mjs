import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BRC_SETTING_KEYS, FileSettingsLock, YamlSettingsStore } from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function createStore(filename, directory) {
  return new YamlSettingsStore({
    filename,
    backupFilename: filename + '.last-good',
    backupKeys: BRC_SETTING_KEYS.filter((key) => key.startsWith('agent.')),
    codec: { parse: (source) => yaml.safeLoad(source), stringify: (settings) => yaml.safeDump(settings, { noRefs: true }) },
    lock: new FileSettingsLock(directory),
  });
}

test('shared file lock serializes independent stores and preserves concurrent settings updates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-shared-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'config');
  const filename = path.join(directory, 'brc.yaml');
  const first = createStore(filename, directory);
  const second = createStore(filename, directory);

  await Promise.all([
    first.update((settings) => { settings.agent.fileReadLineLimit = 111; }),
    second.update((settings) => { settings.agent.fileWriteLineLimit = 22; }),
  ]);

  const current = await first.read();
  assert.equal(current.settings.agent.fileReadLineLimit, 111);
  assert.equal(current.settings.agent.fileWriteLineLimit, 22);
});

test('Agent writes update only Agent keys in the shared last-good snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-shared-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'config');
  const filename = path.join(directory, 'brc.yaml');
  const store = createStore(filename, directory);
  const backup = new YamlSettingsStore({
    filename: filename + '.last-good',
    codec: { parse: (source) => yaml.safeLoad(source), stringify: (settings) => yaml.safeDump(settings, { noRefs: true }) },
    lock: new FileSettingsLock(directory),
  });

  await store.update((settings) => { settings.agent.allowedDirectories = ['C:\\workspace']; });
  const saved = await backup.read();
  assert.deepEqual(saved.settings.agent.allowedDirectories, ['C:\\workspace']);
  const current = await store.read();
  assert.deepEqual(current.settings.agent.allowedDirectories, saved.settings.agent.allowedDirectories);
});
