import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { LifecycleLock as LifecycleLockImpl } from '../packages/cli/dist/adapters/storage/lock.js';
import { LockStore } from '../packages/cli/dist/adapters/storage/lock-store.js';
import { AgentConfigManager } from '../packages/agent/dist/adapters/storage/config-manager.js';
import { resolveAgentPaths } from '../packages/agent/dist/adapters/storage/agent-paths.js';
import { FileSettingsLock, resolveSettings } from '../packages/shared/dist/index.js';

function LifecycleLock(paths, options) {
  return new LifecycleLockImpl(paths, new LockStore(paths), options);
}

const require = createRequire(new URL('../packages/agent/package.json', import.meta.url));
const yaml = require('js-yaml');

test('Agent writes keep the shared last-good config current for CLI rollback', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-cross-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { BRC_DATA_ROOT: root };
  const paths = resolveBrcPaths(env);
  const agentPaths = resolveAgentPaths({ ...env, BRC_CONFIG_FILE: path.join(paths.config, 'brc.yaml') });
  const agent = new AgentConfigManager({ paths: agentPaths, env });
  let applyCount = 0;
  const manager = await SettingsManager.load(paths, env, {
    lock: { runExclusive: async (operation) => operation() },
    apply: async () => {
      applyCount++;
      if (applyCount === 1) throw new Error('runtime apply failed');
    },
  });

  await manager.ensureConfigFile();
  await agent.setValue('allowedDirectories', ['C:\\workspace']);
  await assert.rejects(manager.apply(), /runtime apply failed/);

  const config = resolveSettings(yaml.safeLoad(readFileSync(agentPaths.configFile, 'utf8')), {});
  assert.deepEqual(config.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
});

test('CLI and Agent serialize concurrent updates without losing either setting', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-cross-config-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { BRC_DATA_ROOT: root };
  const paths = resolveBrcPaths(env);
  const agentPaths = resolveAgentPaths({ ...env, BRC_CONFIG_FILE: path.join(paths.config, 'brc.yaml') });
  const agent = new AgentConfigManager({ paths: agentPaths, env });
  const lifecycleLock = new LifecycleLock(paths);
  const configLock = new FileSettingsLock(paths.config);
  const manager = await SettingsManager.load(paths, env, {
    lock: {
      runExclusive: (operation, signal) => lifecycleLock.runExclusive(
        () => configLock.runExclusive(operation, signal), signal,
      ),
    },
    apply: async () => {},
  });
  await manager.ensureConfigFile();
  await Promise.all([
    manager.set('proxy.rate.average', 20),
    agent.setValue('allowedDirectories', ['C:\\workspace']),
  ]);
  const current = resolveSettings(yaml.safeLoad(readFileSync(agentPaths.configFile, 'utf8')), {});
  const backup = resolveSettings(yaml.safeLoad(readFileSync(agentPaths.configFile + '.last-good', 'utf8')), {});
  assert.equal(current.fileSettings.proxy.rate.average, 20);
  assert.deepEqual(current.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
  assert.equal(backup.fileSettings.proxy.rate.average, 20);
  assert.deepEqual(backup.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
});

test('real CLI waits for an Agent process holding the shared configuration lock', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-cross-process-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('BRC_') && key.toUpperCase() !== 'NODE_OPTIONS',
  ));
  env.BRC_DATA_ROOT = root;
  env.BRC_CONFIG_FILE = path.join(root, 'config', 'brc.yaml');
  const paths = resolveBrcPaths(env);
  mkdirSync(paths.config, { recursive: true });
  const initial = 'version: 1\n';
  writeFileSync(env.BRC_CONFIG_FILE, initial);
  writeFileSync(env.BRC_CONFIG_FILE + '.last-good', initial);
  const sharedUrl = new URL('../packages/shared/dist/index.js', import.meta.url).href;
  const agentUrl = new URL('../packages/agent/dist/adapters/storage/config-manager.js', import.meta.url).href;
  const source = `
    import { FileSettingsLock } from ${JSON.stringify(sharedUrl)};
    import { AgentConfigManager } from ${JSON.stringify(agentUrl)};
    const original = FileSettingsLock.prototype.runExclusive;
    FileSettingsLock.prototype.runExclusive = function (operation, signal) {
      return original.call(this, async () => {
        process.send('locked');
        await new Promise((resolve) => process.once('message', resolve));
        return operation();
      }, signal);
    };
    const agent = new AgentConfigManager({ env: process.env });
    await agent.setValue('allowedDirectories', ['C:\\\\workspace']);
    process.disconnect();
  `;
  const agent = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let cli;
  t.after(async () => {
    for (const child of [agent, cli]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  let agentError = '';
  agent.stderr.on('data', (data) => { agentError += data; });
  const agentExit = once(agent, 'exit');
  const [message] = await Promise.race([
    once(agent, 'message'),
    agentExit.then(([code]) => { throw new Error(`Agent exited before locking: ${code} ${agentError}`); }),
  ]);
  assert.equal(message, 'locked');
  const observer = `
    import { FileSettingsLock } from ${JSON.stringify(sharedUrl)};
    const original = FileSettingsLock.prototype.runExclusive;
    FileSettingsLock.prototype.runExclusive = function (operation, signal) {
      process.send('requesting', () => process.disconnect());
      return original.call(this, operation, signal);
    };
  `;
  const cliEnv = { ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(observer)}` };
  cli = spawn(process.execPath, [
    fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url)),
    'config', 'set', 'agent.fileWriteLineLimit', '44',
  ], { env: cliEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let cliError = '';
  cli.stderr.on('data', (data) => { cliError += data; });
  const cliExit = once(cli, 'exit');
  const [request] = await Promise.race([
    once(cli, 'message'),
    cliExit.then(([code]) => { throw new Error(`CLI exited before requesting lock: ${code} ${cliError}`); }),
  ]);
  assert.equal(request, 'requesting');
  assert.equal(cli.exitCode, null);
  assert.equal(readFileSync(env.BRC_CONFIG_FILE, 'utf8'), initial);
  agent.send('continue');
  const [agentCode] = await agentExit;
  const [cliCode] = await cliExit;
  assert.equal(agentCode, 0, agentError);
  assert.equal(cliCode, 0, cliError);
  const current = resolveSettings(yaml.safeLoad(readFileSync(env.BRC_CONFIG_FILE, 'utf8')), {});
  const backup = resolveSettings(yaml.safeLoad(readFileSync(env.BRC_CONFIG_FILE + '.last-good', 'utf8')), {});
  assert.deepEqual(current.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
  assert.equal(current.fileSettings.agent.fileWriteLineLimit, 44);
  assert.deepEqual(backup.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
  assert.equal(backup.fileSettings.agent.fileWriteLineLimit, 44);
});
