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

const yaml = createRequire(import.meta.url)('js-yaml');
const dispatcherUrl = pathToFileURL(path.resolve('packages/agent/dist/adapters/mcp/dispatcher.js')).href;
const compositionUrl = pathToFileURL(path.resolve('packages/agent/dist/composition.js')).href;

async function isolated(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-config-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAgentPaths({ BRC_DATA_ROOT: root });
  return { root, paths, manager: new AgentConfigManager({ paths, env: { BRC_DATA_ROOT: root } }) };
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
    configureAgentServices();
    const { callTool } = await import(${JSON.stringify(dispatcherUrl)});
    const result = await callTool('list_directory', { path: process.env.BRC_DATA_ROOT });
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
    configureAgentServices();
    const { callTool } = await import(${JSON.stringify(dispatcherUrl)});
    const result = await callTool('list_directory', { path: process.env.BRC_DATA_ROOT });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /visible\\.txt/);
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.status, 0, child.stderr);
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
