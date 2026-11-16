import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AgentConfigManager } from '../packages/agent/dist/adapters/storage/config-manager.js';
import { resolveAgentPaths } from '../packages/agent/dist/adapters/storage/agent-paths.js';
import { ConfigStorage } from '../packages/agent/dist/adapters/storage/config-storage.js';
import { BRC_SETTING_KEYS, FileSettingsLock, YamlSettingsStore } from '../packages/shared/dist/index.js';

const yaml = createRequire(import.meta.url)('js-yaml');
const compositionUrl = pathToFileURL(path.resolve('packages/agent/dist/cli.js')).href;

async function isolated(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-config-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAgentPaths({ BRC_DATA_ROOT: root });
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
    { paths, env: { BRC_DATA_ROOT: root } },
  );
  return { root, paths, manager };
}

test('editable Agent settings are validated before persistent writes', async (t) => {
  const { manager, paths } = await isolated(t);
  for (const value of ['abc', NaN, 0, 1.5, Infinity]) {
    await assert.rejects(manager.setUserSetting('fileReadLineLimit', value));
  }
  await assert.rejects(manager.setUserSetting('defaultShell', 42));
  await assert.rejects(manager.setUserSetting('clientId', 'changed'));
  await manager.setUserSetting('telemetryEnabled', 'false');
  assert.equal(await manager.getValue('telemetryEnabled'), false);
  assert.equal(yaml.safeLoad(await readFile(paths.configFile, 'utf8')).agent.telemetry.enabled, false);
});

test('editable command and directory arrays preserve literal strings', async (t) => {
  const { manager } = await isolated(t);
  await manager.setUserSetting('allowedDirectories', 'folder[1]');
  assert.deepEqual(await manager.getValue('allowedDirectories'), ['folder[1]']);
  for (const command of ['true', 'false', '123']) {
    await manager.setUserSetting('blockedCommands', command);
    assert.deepEqual(await manager.getValue('blockedCommands'), [command]);
  }
  await manager.setUserSetting('blockedCommands', '["shutdown","reboot"]');
  assert.deepEqual(await manager.getValue('blockedCommands'), ['shutdown', 'reboot']);
});

test('configuration snapshots cannot mutate stored state', async (t) => {
  const { manager } = await isolated(t);
  await manager.setUserSetting('blockedCommands', ['one']);
  const snapshot = await manager.getConfig();
  snapshot.blockedCommands.push('two');
  const returned = await manager.getValue('blockedCommands');
  returned.push('three');
  assert.deepEqual(await manager.getValue('blockedCommands'), ['one']);
});

test('parallel Agent updates persist both keys without dropping one', async (t) => {
  const { manager, paths } = await isolated(t);
  await Promise.all([
    manager.setUserSetting('fileReadLineLimit', 123),
    manager.setUserSetting('fileWriteLineLimit', 12),
  ]);
  const disk = yaml.safeLoad(await readFile(paths.configFile, 'utf8'));
  assert.equal(disk.agent.fileReadLineLimit, 123);
  assert.equal(disk.agent.fileWriteLineLimit, 12);
});

test('external YAML changes become visible on the next read', async (t) => {
  const { manager, paths } = await isolated(t);
  await manager.setUserSetting('defaultShell', 'before');
  const disk = yaml.safeLoad(await readFile(paths.configFile, 'utf8'));
  disk.agent.defaultShell = 'after';
  await writeFile(paths.configFile, yaml.safeDump(disk));
  assert.equal(await manager.getValue('defaultShell'), 'after');
});

test('invalid YAML fails closed and does not expose private files', async (t) => {
  const { root, paths } = await isolated(t);
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  const damaged = 'version: 1\nagent: [invalid]\n';
  await writeFile(paths.configFile, damaged);
  await writeFile(path.join(root, 'private.txt'), 'confidential-secret');
  const script = `
    import assert from 'node:assert/strict';
    const { configureAgentServices } = await import(${JSON.stringify(compositionUrl)});
    const { dispatcher } = await configureAgentServices();
    const result = await dispatcher.callTool('list_directory', { path: process.env.BRC_DATA_ROOT });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /confidential-secret|private\\.txt/);
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(paths.configFile, 'utf8'), damaged);
});

test('empty directory allowlist still allows unrestricted file reads', async (t) => {
  const { root, paths } = await isolated(t);
  await writeFile(path.join(root, 'visible.txt'), 'contents');
  const script = `
    import assert from 'node:assert/strict';
    const { configureAgentServices } = await import(${JSON.stringify(compositionUrl)});
    const { dispatcher } = await configureAgentServices();
    const result = await dispatcher.callTool('list_directory', { path: process.env.BRC_DATA_ROOT });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /visible\\.txt/);
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
});

test('separate Agent service instances keep remote call context isolated', async (t) => {
  const { root } = await isolated(t);
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    await mkdir(${JSON.stringify(path.join(root, 'allowed'))}, { recursive: true });
    await writeFile(${JSON.stringify(path.join(root, 'allowed', 'sample.txt'))}, 'isolated file content');
    const { configureAgentServices } = await import(${JSON.stringify(compositionUrl)});
    process.env.BRC_DATA_ROOT = ${JSON.stringify(path.join(root, 'first'))};
    process.env.BRC_AGENT_ALLOWED_DIRECTORIES = JSON.stringify([${JSON.stringify(path.join(root, 'allowed'))}]);
    const first = await configureAgentServices();
    first.credentials.save({ relayUrl: 'http://127.0.0.1:10001', deviceId: 'first', deviceToken: 'first-token', name: 'first', pairedAt: 'now' });
    process.env.BRC_DATA_ROOT = ${JSON.stringify(path.join(root, 'second'))};
    process.env.BRC_AGENT_ALLOWED_DIRECTORIES = '[]';
    const second = await configureAgentServices();
    second.credentials.save({ relayUrl: 'http://127.0.0.1:10002', deviceId: 'second', deviceToken: 'second-token', name: 'second', pairedAt: 'now' });
    assert.equal(first.credentials.load().deviceId, 'first');
    assert.equal(second.credentials.load().deviceId, 'second');
    assert.deepEqual(await first.configManager.getValue('allowedDirectories'), [${JSON.stringify(path.join(root, 'allowed'))}]);
    assert.deepEqual(await second.configManager.getValue('allowedDirectories'), []);
    await first.context.runRemote({ name: 'first' }, async () => {
      await Promise.resolve();
      assert.equal(first.context.current().currentRemoteClient.name, 'first');
      assert.equal(second.context.current().currentCallIsRemote, false);
    });
    assert.equal(first.context.current().currentCallIsRemote, false);
    assert.notEqual(first.dispatcher, second.dispatcher);
    const firstHandler = await first.fileHandlers.getFileHandler('sheet.xlsx');
    const secondHandler = await second.fileHandlers.getFileHandler('sheet.xlsx');
    assert.notEqual(firstHandler, secondHandler);
    assert.equal(await first.fileHandlers.getFileHandler('other.xlsx'), firstHandler);
    assert.equal(first.fileHandlers.isExcelFile('sheet.xlsx'), true);
    const readResult = await first.dispatcher.callTool('read_file', { path: ${JSON.stringify(path.join(root, 'allowed', 'sample.txt'))} });
    assert.notEqual(readResult.isError, true);
    assert.match(JSON.stringify(readResult), /isolated file content/);
    const running = first.dispatcher.callTool('get_config', {});
    await first.dispatcher.stop();
    assert.notEqual((await running).isError, true);
    assert.equal((await first.dispatcher.callTool('get_config', {})).isError, true);
    assert.notEqual((await second.dispatcher.callTool('get_config', {})).isError, true);
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
});

test('search stopped during path authorization cannot start a process', async () => {
  const { SearchManager } = await import('../packages/agent/dist/adapters/system/search-manager.js');
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const configManager = {
    getConfig: () => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const manager = new SearchManager({ configManager, capture: async () => {} });
  const starting = manager.startSearch({ rootPath: os.tmpdir(), pattern: 'anything', searchType: 'files' });
  await waiting;
  manager.stop();
  release({ allowedDirectories: [] });
  await assert.rejects(starting, /stopp/i);
});

test('search shutdown waits for accepted office searches', { timeout: 8000 }, async () => {
  const { SearchManager } = await import('../packages/agent/dist/adapters/system/search-manager.js');
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const manager = new SearchManager({
    configManager: { getConfig: async () => ({ allowedDirectories: [] }) },
    capture: async () => {},
  });
  manager.searchDocxFiles = async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return [];
  };
  const search = manager.startSearch({
    rootPath: os.tmpdir(), pattern: 'needle', searchType: 'content', filePattern: '*.docx',
  });
  await Promise.race([entered, search.then(() => { throw new Error('Office search did not start.'); })]);
  let stopped = false;
  const stopping = manager.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  await search;
  assert.equal(stopped, true);
});

test('tool activity uses the full resolved logging settings', async (t) => {
  const { root, paths } = await isolated(t);
  await mkdir(paths.logsDirectory, { recursive: true });
  const log = path.join(paths.logsDirectory, 'agent-tool-calls.log');
  await writeFile(log, 'x'.repeat(1024 * 1024));
  const script = `
    import assert from 'node:assert/strict';
    const { configureAgentServices } = await import(${JSON.stringify(compositionUrl)});
    const { dispatcher } = await configureAgentServices();
    const result = await dispatcher.callTool('get_config', {});
    assert.notEqual(result.isError, true);
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...env, BRC_DATA_ROOT: root, BRC_LOG_ROTATE_MIB: '1', BRC_LOG_MAX_TOTAL_MIB: '128', DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal((await readFile(log + '.1', 'utf8')).length, 1024 * 1024);
  assert.match(await readFile(log, 'utf8'), /get_config/);
});

test('state JSON writes retry transient Windows rename failures', { skip: process.platform !== 'win32' }, async (t) => {
  const { root } = await isolated(t);
  const filename = path.join(root, 'state.json');
  const storage = new ConfigStorage(filename);
  await storage.prepare();
  await writeFile(filename, '{"marker":"old"}');
  const fs = (await import('node:fs/promises')).default;
  const original = fs.rename;
  t.after(() => { fs.rename = original; });
  let attempts = 0;
  fs.rename = async (...args) => {
    if (++attempts === 1) throw Object.assign(new Error('transient sharing violation'), { code: 'EPERM' });
    return original(...args);
  };
  await storage.write({ marker: 'new' });
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).marker, 'new');
});

test('persistent rename denial preserves existing state JSON', { skip: process.platform !== 'win32' }, async (t) => {
  const { root } = await isolated(t);
  const filename = path.join(root, 'state.json');
  const storage = new ConfigStorage(filename);
  await storage.prepare();
  await writeFile(filename, '{"marker":"original"}');
  const fs = (await import('node:fs/promises')).default;
  const original = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  try { await assert.rejects(storage.write({ marker: 'bad' }), { code: 'EACCES' }); }
  finally { fs.rename = original; }
  assert.equal(await readFile(filename, 'utf8'), '{"marker":"original"}');
});
