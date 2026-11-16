import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('connect --allow-dir persists the policy in Shared YAML before connection', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-allow-dir-'));
  const state = path.join(root, 'data', 'agent');
  const allowed = path.join(root, 'allowed');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'device.json'), JSON.stringify({
    relayUrl: 'http://127.0.0.1:1', deviceId: 'local-id', deviceToken: 'private',
    name: 'test-agent', pairedAt: '2026-11-16',
  }));
  const binary = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawn(process.execPath, [binary, 'connect', '--allow-dir', allowed, '--no-browser'], {
    env: { ...env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'config', 'brc.yaml');
  const deadline = Date.now() + 5000;
  while (!existsSync(filename) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(filename), 'connect did not write policy: ' + output);
  const yaml = createRequire(import.meta.url)('js-yaml');
  assert.deepEqual(yaml.safeLoad(readFileSync(filename, 'utf8')).agent.allowedDirectories, [allowed]);
});

test('history shutdown reports timeouts and failures without exposing error contents', async () => {
  const { flushAgentHistory } = await import('../packages/agent/dist/adapters/transport/connection.js');
  const messages = [];
  await flushAgentHistory({ cleanup: () => new Promise(() => {}) }, message => messages.push(message), 10);
  await flushAgentHistory({ cleanup: async () => { throw new Error('private-history-value'); } }, message => messages.push(message), 100);
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages.join(' '), /private-history-value/);
});

test('history shutdown awaits an accepted flush', async () => {
  const { flushAgentHistory } = await import('../packages/agent/dist/adapters/transport/connection.js');
  let flushed = false;
  const messages = [];
  await flushAgentHistory({ cleanup: async () => { flushed = true; } }, message => messages.push(message), 100);
  assert.equal(flushed, true);
  assert.deepEqual(messages, []);
});

test('connection uses instance control environment and skips disabled diagnostic parameters', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-instance-control-'));
  const ready = path.join(root, 'ready.json');
  const wrong = path.join(root, 'wrong.json');
  const script = `
    const { configureAgentServices } = await import(${JSON.stringify(new URL('../packages/agent/dist/index.js', import.meta.url).href)});
    const { parseAgentInvocation } = await import(${JSON.stringify(new URL('../packages/agent/dist/commands/parser.js', import.meta.url).href)});
    const { runAgentConnection } = await import(${JSON.stringify(new URL('../packages/agent/dist/adapters/transport/connection.js', import.meta.url).href)});
    const { createServer } = await import('node:http');
    const { createDiagnosticsRuntime } = await import(${JSON.stringify(new URL('../packages/shared/dist/index.js', import.meta.url).href)});
    const services = await configureAgentServices();
    process.env.BRC_CONTROL_READY_FILE = ${JSON.stringify(wrong)};
    process.env.BRC_CONTROL_TOKEN = 'wrong-token';
    const result = await services.dispatcher.callTool('get_config', {});
    if (result.isError) throw new Error('Config tool failed with diagnostics disabled');
    await runAgentConnection(parseAgentInvocation(['connect', '--no-browser']), services, createDiagnosticsRuntime({ enabled: false, component: 'agent' }), createServer());
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...env, DO_NOT_TRACK: '1', BRC_DATA_ROOT: root, BRC_CONTROL_READY_FILE: ready,
      BRC_CONTROL_TOKEN: 'instance-token', BRC_MANAGED_ID: 'instance-id', BRC_MANAGED_SERVICE: 'agent',
      BRC_RELAY: 'http://127.0.0.1:1', BRC_DEVICE_ID: 'device', BRC_TOKEN: 'token',
      BRC_DIAGNOSTICS_ENABLED: 'false', BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS: 'invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(ready), errors);
  assert.equal(JSON.parse(readFileSync(ready, 'utf8')).id, 'instance-id');
  assert.equal(existsSync(wrong), false);
});

test('direct connection stores enabled diagnostic snapshots under its data root', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-diagnostic-root-'));
  const binary = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawn(process.execPath, [binary, 'connect', '--no-browser'], {
    env: {
      ...env, DO_NOT_TRACK: '1', BRC_DATA_ROOT: root,
      BRC_RELAY: 'http://127.0.0.1:1', BRC_DEVICE_ID: 'device', BRC_TOKEN: 'token',
      BRC_DIAGNOSTICS_ENABLED: 'true', BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'diagnostics');
  const deadline = Date.now() + 7000;
  while (!existsSync(directory) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(directory), errors);
});
