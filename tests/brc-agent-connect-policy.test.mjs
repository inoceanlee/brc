import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

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
  assert.match(messages[0], /timed out/);
  assert.match(messages[1], /failed/);
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

test('managed shutdown reports usage write failure without private error contents', async (t) => {
  const { createToolDispatcher } = await import('../packages/agent/dist/adapters/mcp/dispatcher.js');
  const { startManagedControlServer } = await import('../packages/shared/dist/index.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-usage-shutdown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateValue = 'private-usage-json-value';
  const logs = [];
  const previous = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  let control;
  try {
    const dispatcher = createToolDispatcher({
      searchManager: { listSearchSessions: () => [] },
      usageTracker: { trackSuccess: async () => { throw new Error(privateValue); } },
      toolHistory: { addCall() {} },
      trackToolCall: async () => {},
    });
    const result = await dispatcher.callTool('list_searches', {});
    assert.notEqual(result.isError, true);
    control = await startManagedControlServer({
      server: createServer(),
      token: 'test-token',
      readyFile: path.join(root, 'ready.json'),
      id: 'usage-test',
      service: 'agent',
      health: () => ({ state: 'running', detail: 'ready' }),
      stop: () => dispatcher.stop(),
      onStopError: () => {},
    });
    const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error.message, /usage storage write failed/i);
    assert.doesNotMatch(JSON.stringify(body), /private-usage-json-value/);
    assert.match(logs.join('\n'), /usage storage write failed/i);
    assert.doesNotMatch(logs.join('\n'), /private-usage-json-value/);
  } finally {
    console.error = previous;
    await control?.close();
  }
});

test('startup failure retains sanitized shutdown failure classification', async (t) => {
  const previousSignals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, new Set(process.listeners(signal))]));
  t.after(() => {
    for (const [signal, before] of previousSignals) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
  });
  const { runAgentConnection } = await import('../packages/agent/dist/adapters/transport/connection.js');
  const { parseAgentInvocation } = await import('../packages/agent/dist/commands/parser.js');
  const { DEFAULT_SETTINGS } = await import('../packages/shared/dist/index.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-control-privacy-'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const services = {
    env: {
      BRC_TOKEN: 'test-token', BRC_CONTROL_TOKEN: 'control-token',
      BRC_CONTROL_READY_FILE: path.join(root, 'ready.json'),
      BRC_MANAGED_ID: 'privacy-test', BRC_MANAGED_SERVICE: 'agent',
    },
    settingsStore: { read: async () => ({ settings: DEFAULT_SETTINGS, revision: null }) },
    logger: { bind: () => () => {} },
    bindHistoryFailureReporter: () => () => {},
    credentials: { load: () => null },
    dispatcher: {
      listTools: () => [],
      stop: async () => { throw new AggregateError([new Error('Agent usage storage write failed.')], 'usage failed'); },
    },
    searchManager: { stop: async () => { throw new Error('private-search-value'); } },
    toolHistory: { cleanup: async () => {} },
    createClient: () => { throw new Error('private-startup-value'); },
  };
  const diagnostics = { log() {}, getLogFailure: () => undefined, stop: async () => { throw new Error('private-diagnostic-value'); } };
  const invocation = parseAgentInvocation(['connect', '--relay', 'http://127.0.0.1:1', '--device-id', 'test', '--no-browser']);
  await assert.rejects(runAgentConnection(invocation, services, diagnostics, server), (error) =>
    /Agent startup failed/.test(error.message)
    && /Agent usage storage write failed/.test(error.message)
    && /Agent search shutdown failed/.test(error.message)
    && /Agent diagnostics shutdown failed/.test(error.message)
    && /Agent control shutdown failed/.test(error.message)
    && !/private-(startup|search|diagnostic)-value/.test(error.message));
  services.env = { BRC_TOKEN: 'test-token' };
  await assert.rejects(runAgentConnection(invocation, services, diagnostics, createServer()), (error) =>
    /Agent startup failed/.test(error.message)
    && /Agent search shutdown failed/.test(error.message)
    && /Agent diagnostics shutdown failed/.test(error.message)
    && !/private-(startup|search|diagnostic)-value/.test(error.message));
});

test('connection uses instance control environment and skips disabled diagnostic parameters', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-instance-control-'));
  const ready = path.join(root, 'ready.json');
  const wrong = path.join(root, 'wrong.json');
  const script = `
    const { configureAgentServices } = await import(${JSON.stringify(new URL('../packages/agent/dist/cli.js', import.meta.url).href)});
    const { parseAgentInvocation } = await import(${JSON.stringify(new URL('../packages/agent/dist/commands/parser.js', import.meta.url).href)});
    const { runAgentConnection } = await import(${JSON.stringify(new URL('../packages/agent/dist/adapters/transport/connection.js', import.meta.url).href)});
    const { createServer } = await import('node:http');
    const { createDiagnosticsRuntime } = await import(${JSON.stringify(new URL('../packages/shared/dist/index.js', import.meta.url).href)});
    const services = await configureAgentServices();
    process.env.BRC_CONTROL_READY_FILE = ${JSON.stringify(wrong)};
    process.env.BRC_CONTROL_TOKEN = 'wrong-token';
    const result = await services.dispatcher.callTool('get_config', {});
    if (result.isError) throw new Error('Config tool failed with diagnostics disabled');
    const diagnostics = createDiagnosticsRuntime({
      enabled: true, component: 'agent',
      log: { write: async () => { throw new Error('diagnostic sink failed'); }, flush: async () => {} },
    });
    diagnostics.log('event');
    await runAgentConnection(parseAgentInvocation(['connect', '--no-browser']), services, diagnostics, createServer());
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
  const health = await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(ready, 'utf8')).port}/health`, {
    headers: { authorization: 'Bearer instance-token' },
  });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).detail, 'Agent diagnostic logging failed.');
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
