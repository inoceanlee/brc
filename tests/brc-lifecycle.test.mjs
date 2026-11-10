import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessManager, inspectProcess } from '../packages/cli/dist/lifecycle/processes.js';
import { inspectProcesses } from '../packages/cli/dist/lifecycle/identity.js';
import { ServiceManager, createDefaultServices } from '../packages/cli/dist/lifecycle/services.js';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { LifecycleLock } from '../packages/cli/dist/lifecycle/lock.js';
import { startManagedControlServer } from '../packages/shared/dist/managed-control.js';

const fakeService = `
import { createServer } from 'node:http';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
const mode = process.env.BRC_TEST_MODE ?? 'normal';
const token = process.env.BRC_CONTROL_TOKEN;
const readyFile = process.env.BRC_CONTROL_READY_FILE;
const id = process.env.BRC_MANAGED_ID;
const name = process.env.BRC_MANAGED_SERVICE;
const servicePort = Number(process.env.BRC_TEST_PORT ?? 0);
if (servicePort) {
  const service = createServer((_req, res) => res.end('existing-service'));
  try {
    await new Promise((resolve, reject) => {
      service.once('error', reject);
      service.listen(servicePort, '127.0.0.1', resolve);
    });
  } catch {
    process.exit(23);
  }
}
const healthyAt = Date.now() + Number(process.env.BRC_TEST_HEALTH_DELAY ?? 0);
let healthHits = 0;
const control = createServer((req, res) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== 'Bearer ' + token) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    if (process.env.BRC_TEST_HEALTH_TRACE) appendFileSync(process.env.BRC_TEST_HEALTH_TRACE, 'health\\n');
    healthHits++;
    if (mode === 'flaky' && healthHits === 2) { req.socket.destroy(); return; }
    if (mode === 'exit-on-health') {
      req.socket.destroy();
      process.exit(0);
    }
    if (Date.now() < healthyAt) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, state: 'starting', detail: 'starting' }));
      return;
    }
    if (mode === 'pairing') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, state: 'pairing', detail: 'Awaiting device approval.' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, state: 'running', detail: 'fake service ready' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(202).end();
    if (mode !== 'hang') setTimeout(() => process.exit(0), 20);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(0, '127.0.0.1', resolve);
});
const address = control.address();
const ready = readyFile + '.tmp';
if (process.env.BRC_TEST_READY_BEFORE_READY_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.BRC_TEST_READY_BEFORE_READY_DELAY)));
writeFileSync(ready, JSON.stringify({ id, service: name, pid: process.pid, port: address.port }));
renameSync(ready, readyFile);
if (mode === 'exit') setTimeout(() => process.exit(0), Number(process.env.BRC_TEST_EXIT_MS ?? 250));
if (process.env.BRC_TEST_READY_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.BRC_TEST_READY_DELAY)));
`;

function service(name, entrypoint, root, env = {}) {
  return { name, entrypoint, workspaceRoot: root, cwd: root, args: [], env };
}

function paths(root) {
  return {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  };
}

async function makeHarness(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lifecycle-'));
  const runtimePaths = paths(root);
  await mkdir(runtimePaths.runtime, { recursive: true });
  const entrypoint = path.join(root, 'fake-service.mjs');
  await writeFile(entrypoint, fakeService);
  const spec = service(options.name ?? 'relay', entrypoint, root, {
    BRC_TEST_MODE: options.mode ?? 'normal',
    ...(options.env ?? {}),
  });
  const manager = new ProcessManager(runtimePaths, {
    startupTimeoutMs: options.startupTimeoutMs ?? 3000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 300,
    pollIntervalMs: 25,
    ...(options.processOptions ?? {}),
  });
  t.after(async () => {
    try { await manager.stop(spec); } catch { return; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, paths: runtimePaths, spec, manager, entrypoint };
}

test('batch inspection validates and deduplicates process IDs', async () => {
  assert.deepEqual(await inspectProcesses([]), new Map());
  await assert.rejects(inspectProcesses([process.pid, 0]), /Invalid process ID/);
  const identities = await inspectProcesses([process.pid, process.pid, 2147483647]);
  assert.equal(identities.size, 2);
  assert.equal(identities.get(process.pid)?.pid, process.pid);
  assert.equal(identities.get(2147483647), null);
});

test('statusMany isolates record errors and honors the injected inspector', async (t) => {
  let mismatch = false;
  const harness = await makeHarness(t, { processOptions: { inspectProcess: async (pid) => {
    const identity = await inspectProcess(pid);
    return mismatch && identity ? { ...identity, createdAt: 'reused' } : identity;
  }}});
  await harness.manager.start(harness.spec);
  const agent = service('agent', harness.entrypoint, harness.root);
  await writeFile(path.join(harness.paths.runtime, 'agent.json'), '{');
  try {
    mismatch = true;
    const statuses = await harness.manager.statusMany([harness.spec, agent]);
    assert.equal(statuses[0].state, 'degraded');
    assert.match(statuses[0].detail, /identity/i);
    assert.equal(statuses[1].state, 'degraded');
    await assert.rejects(harness.manager.stop(harness.spec), /identity/i);
  } finally {
    mismatch = false;
  }
});

test('status retries a transient process inspection error before reporting degraded', async (t) => {
  let failNext = false;
  const harness = await makeHarness(t, {
    processOptions: { inspectProcess: async (pid) => {
      if (failNext) { failNext = false; throw new Error('transient process query failure'); }
      return inspectProcess(pid);
    }},
  });
  await harness.manager.start(harness.spec);
  failNext = true;
  assert.equal((await harness.manager.status(harness.spec)).state, 'running');
});

test('transient health transport errors do not mark a responsive process degraded', async (t) => {
  const harness = await makeHarness(t, { mode: 'flaky' });
  await harness.manager.start(harness.spec);
  assert.equal((await harness.manager.status(harness.spec)).state, 'running');
});

test('unpaired agent starts without treating human approval as a process failure', async (t) => {
  const harness = await makeHarness(t, { name: 'agent', mode: 'pairing', startupTimeoutMs: 15_000 });
  await harness.manager.start(harness.spec);
  await harness.manager.start(harness.spec);
  assert.equal((await harness.manager.status(harness.spec)).state, 'pairing');
});

test('startup health polling does not repeat process identity inspection', async (t) => {
  let inspections = 0;
  const harness = await makeHarness(t, {
    env: { BRC_TEST_HEALTH_DELAY: '1200' },
    startupTimeoutMs: 5000,
    processOptions: { inspectProcess: async (pid) => { inspections++; return inspectProcess(pid); } },
  });
  await harness.manager.start(harness.spec);
  assert.equal(inspections, 1);
});

test('startup identity inspection shares the ready and health deadline', async (t) => {
  let inspections = 0;
  const harness = await makeHarness(t, {
    startupTimeoutMs: 3000,
    processOptions: { inspectProcess: async (pid) => {
      inspections++;
      const identity = await inspectProcess(pid);
      if (inspections === 1) await sleep(3100);
      return identity;
    } },
  });
  const trace = path.join(harness.root, 'health-trace');
  harness.spec.env.BRC_TEST_HEALTH_TRACE = trace;
  await assert.rejects(harness.manager.start(harness.spec), /healthy|timeout/i);
  assert.ok(inspections >= 1);
  await assert.rejects(readFile(trace, 'utf8'), { code: 'ENOENT' });
});

test('startup rejects a child that exits during readiness and removes its record', async (t) => {
  const harness = await makeHarness(t, { mode: 'exit-on-health', startupTimeoutMs: 5000 });
  await assert.rejects(harness.manager.start(harness.spec), /exited|healthy/i);
  await assert.rejects(readFile(path.join(harness.paths.runtime, 'relay.json'), 'utf8'), { code: 'ENOENT' });
});

test('runtime timeout updates apply to the next managed process start', async (t) => {
  const harness = await makeHarness(t, {
    startupTimeoutMs: 50,
    shutdownTimeoutMs: 300,
    env: { BRC_TEST_READY_BEFORE_READY_DELAY: '200' },
  });

  await assert.rejects(harness.manager.start(harness.spec), /ready|timeout/i);
  harness.manager.updateRuntimeSettings({ startupTimeoutMs: 15_000, shutdownTimeoutMs: 500 });
  await harness.manager.start(harness.spec);

  assert.equal((await harness.manager.status(harness.spec)).state, 'running');
});

class FakeProcessManager {
  constructor({ failStart, delayMs = 0 } = {}) {
    this.failStart = failStart;
    this.delayMs = delayMs;
    this.calls = [];
    this.states = new Map();
    this.active = 0;
    this.maxActive = 0;
  }

  async status(spec) {
    return this.states.get(spec.name) ?? { name: spec.name, state: 'stopped', pid: null, detail: 'not started' };
  }

  async start(spec) {
    this.calls.push(`start:${spec.name}`);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await sleep(this.delayMs);
      if (this.failStart === spec.name) throw new Error(`failed:${spec.name}`);
      this.states.set(spec.name, { name: spec.name, state: 'running', pid: 100, detail: 'healthy' });
    } finally {
      this.active--;
    }
  }

  async stop(spec) {
    this.calls.push(`stop:${spec.name}`);
    this.states.set(spec.name, { name: spec.name, state: 'stopped', pid: null, detail: 'stopped' });
  }
}

function workspaceServices(root) {
  return [service('relay', path.join(root, 'relay.js'), root), service('agent', path.join(root, 'agent.js'), root)];
}

test('protects managed control endpoints and runs shutdown once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-'));
  const env = {
    BRC_CONTROL_TOKEN: 'a'.repeat(64),
    BRC_CONTROL_READY_FILE: path.join(root, 'relay.ready.json'),
    BRC_MANAGED_ID: '00000000-0000-4000-8000-000000000001',
    BRC_MANAGED_SERVICE: 'relay',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let control;
  const stops = [];
  try {
    control = await startManagedControlServer({
      health: () => ({ state: 'running', detail: 'Relay ready.' }),
      stop: () => { stops.push('stop'); },
    });
    assert.ok(control);
    const endpoint = `http://127.0.0.1:${control.port}`;
    assert.equal((await fetch(`${endpoint}/health`)).status, 404);
    assert.equal((await fetch(`${endpoint}/health`, {
      headers: { authorization: 'Bearer invalid' },
    })).status, 404);
    const health = await fetch(`${endpoint}/health`, {
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    });
    assert.deepEqual(await health.json(), { ok: true, state: 'running', detail: 'Relay ready.' });
    assert.equal((await fetch(`${endpoint}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    })).status, 202);
    assert.equal((await fetch(`${endpoint}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    })).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stops, ['stop']);
  } finally {
    await control?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to stop and preserves a malformed process record', async (t) => {
  const harness = await makeHarness(t);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const contents = '{malformed';
  await writeFile(filename, contents);

  await assert.rejects(harness.manager.stop(harness.spec), /JSON|malformed|incomplete/i);
  assert.equal(await readFile(filename, 'utf8'), contents);
  assert.equal((await harness.manager.status(harness.spec)).state, 'degraded');
});

test('starts in order, makes start and stop idempotent, and stops in reverse order', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const processes = new FakeProcessManager();
  const manager = new ServiceManager(runtimePaths, workspaceServices(root), processes);

  await manager.start();
  await manager.start();
  await manager.stop();
  await manager.stop();

  assert.deepEqual(processes.calls, ['start:relay', 'start:agent', 'stop:agent', 'stop:relay']);
});

test('start trusts successful readiness and status uses the batch API', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new FakeProcessManager();
  const checked = [];
  const status = processes.status.bind(processes);
  processes.status = async (spec) => { checked.push(spec.name); return status(spec); };
  let batches = 0;
  processes.statusMany = async (specs) => {
    batches++;
    return Promise.all(specs.map(status));
  };
  const manager = new ServiceManager(paths(root), workspaceServices(root), processes);
  await manager.start();
  assert.deepEqual(checked, ['relay', 'agent']);
  assert.equal((await manager.status()).length, 2);
  assert.equal(batches, 1);
});

test('service operations refresh configuration after acquiring the shared lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const initial = workspaceServices(root).map((spec) => ({ ...spec, env: { PORT: '13000' } }));
  const refreshed = workspaceServices(root).map((spec) => ({ ...spec, env: { PORT: '13001' } }));
  const lock = new LifecycleLock(runtimePaths);
  const processes = new FakeProcessManager();
  const startedPorts = [];
  const start = processes.start.bind(processes);
  processes.start = async (spec) => {
    startedPorts.push(spec.env.PORT);
    await start(spec);
  };
  let refreshCount = 0;
  const manager = new ServiceManager(runtimePaths, initial, processes, lock, async () => {
    await assert.rejects(lock.runExclusive(async () => {}), /cannot be acquired recursively/i);
    refreshCount++;
    return refreshed;
  });

  await manager.start();

  assert.equal(refreshCount, 1);
  assert.deepEqual(startedPorts, ['13001', '13001']);
});

test('service start refreshes settings changed by another CLI process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cross-process-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  env.BRC_DATA_ROOT = root;
  const cliEntry = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
  const initial = spawnSync(process.execPath, [cliEntry, 'config', 'set', 'services.relayPort', '13000'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);

  const readyFile = path.join(root, 'ready');
  const gateFile = path.join(root, 'continue');
  const portFile = path.join(root, 'started-port');
  const source = `
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveBrcPaths } from ${JSON.stringify(new URL('../packages/cli/dist/config/paths.js', import.meta.url).href)};
import { readSettings } from ${JSON.stringify(new URL('../packages/cli/dist/config/reader.js', import.meta.url).href)};
import { createDefaultServices, ServiceManager } from ${JSON.stringify(new URL('../packages/cli/dist/lifecycle/services.js', import.meta.url).href)};
import { LifecycleLock } from ${JSON.stringify(new URL('../packages/cli/dist/lifecycle/lock.js', import.meta.url).href)};
const paths = resolveBrcPaths(process.env);
const initial = await readSettings(paths, process.env);
if (initial.settings.services.relayPort !== 13000) throw new Error('initial settings were not loaded');
const relayServices = (settings) => createDefaultServices(paths, settings, process.env).filter((service) => service.name === 'relay');
const states = new Map();
const processes = {
  async status(spec) { return states.get(spec.name) ?? { name: spec.name, state: 'stopped', pid: null, detail: 'not started' }; },
  async start(spec) {
    await writeFile(${JSON.stringify(portFile)}, spec.env.PORT);
    states.set(spec.name, { name: spec.name, state: 'running', pid: 100, detail: 'healthy' });
  },
  async stop(spec) { states.set(spec.name, { name: spec.name, state: 'stopped', pid: null, detail: 'stopped' }); },
};
const lock = new LifecycleLock(paths);
const manager = new ServiceManager(paths, relayServices(initial.settings), processes, lock, async () => {
  const current = await readSettings(paths, process.env);
  return relayServices(current.settings);
});
await writeFile(${JSON.stringify(readyFile)}, 'ready');
for (;;) {
  try { await readFile(${JSON.stringify(gateFile)}); break; }
  catch { await sleep(10); }
}
await manager.start();
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const childResult = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await childResult;
    }
  });

  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await readFile(readyFile);
      break;
    } catch {
      if (child.exitCode !== null) assert.fail(`service process exited before loading settings: ${stderr}`);
      await sleep(10);
    }
  }
  assert.equal(await readFile(readyFile, 'utf8'), 'ready');

  const settingsFile = path.join(root, 'config', 'brc.yaml');
  const yaml = await readFile(settingsFile, 'utf8');
  const updatedYaml = yaml.replace('relayPort: 13000', 'relayPort: 13003');
  assert.notEqual(updatedYaml, yaml);
  await writeFile(settingsFile, updatedYaml);
  const applied = spawnSync(process.execPath, [cliEntry, 'config', 'apply'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  await writeFile(gateFile, 'continue');

  assert.deepEqual(await childResult, { code: 0, signal: null }, stderr);
  assert.equal(await readFile(portFile, 'utf8'), '13003');
});

test('rolls back already-started services when a later service fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new FakeProcessManager({ failStart: 'agent' });
  const manager = new ServiceManager(paths(root), workspaceServices(root), processes);

  await assert.rejects(manager.start(), /failed:agent/);

  assert.deepEqual(processes.calls, ['start:relay', 'start:agent', 'stop:relay']);
  assert.equal((await processes.status({ name: 'relay' })).state, 'stopped');
});

test('serializes lifecycle calls across manager instances sharing one runtime root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const processes = new FakeProcessManager({ delayMs: 150 });
  const services = workspaceServices(root);
  const first = new ServiceManager(runtimePaths, services, processes, new LifecycleLock(runtimePaths, { waitMs: 10_000 }));
  const second = new ServiceManager(runtimePaths, services, processes, new LifecycleLock(runtimePaths, { waitMs: 10_000 }));

  const firstRun = first.start();
  const secondRun = second.restart();
  const results = await Promise.allSettled([firstRun, secondRun]);

  assert.equal(processes.maxActive, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2,
    results.filter((result) => result.status === 'rejected').map((result) => {
      const errors = [];
      let error = result.reason;
      while (error) { errors.push(error.stack ?? String(error)); error = error.cause; }
      return errors.join(' CAUSE: ');
    }).join('\n'));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
});

test('serializes separate ServiceManagers that share a lifecycle lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const processes = new FakeProcessManager({ delayMs: 30 });
  const services = workspaceServices(root);
  const lock = new LifecycleLock(runtimePaths);
  const first = new ServiceManager(runtimePaths, services, processes, lock);
  const second = new ServiceManager(runtimePaths, services, processes, lock);

  const results = await Promise.allSettled([first.start(), second.restart()]);

  assert.equal(processes.maxActive, 1);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
});

test('rejects nested lifecycle lock acquisition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = new LifecycleLock(paths(root));

  await assert.rejects(
    lock.runExclusive(() => lock.runExclusive(async () => {})),
    /cannot be acquired recursively/i,
  );
});

test('prevents a second CLI process from acquiring an active lifecycle lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const marker = path.join(root, 'held');
  const lock = new LifecycleLock(runtimePaths);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const owner = lock.runExclusive(async () => {
    await writeFile(marker, 'held');
    await released;
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(marker, 'utf8');
        break;
      } catch {
        if (attempt === 99) throw new Error('The lock owner did not start.');
        await sleep(10);
      }
    }

    const lockUrl = new URL('../packages/cli/dist/lifecycle/lock.js', import.meta.url).href;
    const source = `
      import { LifecycleLock } from ${JSON.stringify(lockUrl)};
      await new LifecycleLock(${JSON.stringify(runtimePaths)}).runExclusive(async () => {});
      console.log('unexpectedly acquired');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    assert.deepEqual(result, { code: 1, signal: null }, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /Another BRC lifecycle operation is in progress/);
  } finally {
    release();
    await owner;
  }
});

test('persists identity and allows another CLI instance to inspect and stop the child', async (t) => {
  const harness = await makeHarness(t);
  const { manager, spec } = harness;

  await manager.start(spec);
  const started = await manager.status(spec);
  const nextCli = new ProcessManager(harness.paths, { shutdownTimeoutMs: 300, pollIntervalMs: 25 });
  const observed = await nextCli.status(spec);

  assert.equal(started.state, 'running');
  assert.equal(typeof started.pid, 'number');
  assert.equal(observed.pid, started.pid);
  assert.match(observed.detail, /fake service ready/);
  await nextCli.stop(spec);
  assert.equal((await manager.status(spec)).state, 'stopped');
});

test('lets the CLI process exit while the managed service keeps running', async (t) => {
  const harness = await makeHarness(t);
  const processManagerUrl = JSON.stringify(new URL('../packages/cli/dist/lifecycle/processes.js', import.meta.url).href);
  const source = `import { ProcessManager } from ${processManagerUrl};
await new ProcessManager(${JSON.stringify(harness.paths)}, { startupTimeoutMs: 3000, shutdownTimeoutMs: 300, pollIntervalMs: 25 }).start(${JSON.stringify(harness.spec)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('CLI process remained open after starting the managed service.'));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal((await harness.manager.status(harness.spec)).state, 'running');
});

test('reports an exited process as stopped and refuses a reused PID', async (t) => {
  const exited = await makeHarness(t);
  await exited.manager.start(exited.spec);
  const running = await exited.manager.status(exited.spec);
  assert.equal(running.state, 'running');
  assert.ok(running.pid);
  process.kill(running.pid);
  let afterExit = await exited.manager.status(exited.spec);
  for (let attempt = 0; attempt < 5 && afterExit.state !== 'stopped'; attempt++) {
    await sleep(100);
    afterExit = await exited.manager.status(exited.spec);
  }
  assert.equal(afterExit.state, 'stopped');
  const harness = await makeHarness(t);
  let reused = false;
  const manager = new ProcessManager(harness.paths, {
    startupTimeoutMs: 3000,
    shutdownTimeoutMs: 150,
    pollIntervalMs: 25,
    inspectProcess: async (pid) => {
      const identity = await inspectProcess(pid);
      return reused && identity ? { ...identity, createdAt: `${identity.createdAt}-reused` } : identity;
    },
  });
  await manager.start(harness.spec);
  reused = true;

  await assert.rejects(manager.stop(harness.spec), /identity|reused|match/i);
  assert.equal((await manager.status(harness.spec)).state, 'degraded');
  reused = false;
  await manager.stop(harness.spec);
});

test('leaves an unrelated listener untouched when a service port is occupied', async (t) => {
  const listener = createServer((_req, res) => res.end('preserved'));
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(() => resolve())));
  const port = listener.address().port;
  const harness = await makeHarness(t, { env: { BRC_TEST_PORT: String(port) } });

  await assert.rejects(harness.manager.start(harness.spec), /exited|ready|start/i);
  const response = await fetch(`http://127.0.0.1:${port}`);

  assert.equal(await response.text(), 'preserved');
  assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
});

test('force-stops only identity-matched process after controlled shutdown times out', async (t) => {
  const harness = await makeHarness(t, { mode: 'hang', shutdownTimeoutMs: 150 });
  const neighbor = service('agent', harness.entrypoint, harness.root, { BRC_TEST_MODE: 'normal' });
  await harness.manager.start(harness.spec);
  await harness.manager.start(neighbor);
  const neighborRecord = await harness.manager.status(neighbor);

  await harness.manager.stop(harness.spec);

  assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
  const neighborStatus = await harness.manager.status(neighbor);
  assert.equal(neighborStatus.pid, neighborRecord.pid);
  assert.equal(neighborStatus.state, 'running');
  await harness.manager.stop(neighbor);
});

test('refuses forced termination when the PID identity changes after shutdown', async (t) => {
  let stopInspections = 0;
  let stopping = false;
  const harness = await makeHarness(t, {
    mode: 'hang',
    shutdownTimeoutMs: 0,
    processOptions: { inspectProcess: async (pid) => {
      const identity = await inspectProcess(pid);
      if (stopping && ++stopInspections >= 2 && identity) return { ...identity, createdAt: 'reused' };
      return identity;
    }},
  });
  await harness.manager.start(harness.spec);
  try {
    stopping = true;
    await assert.rejects(harness.manager.stop(harness.spec), /identity changed before forced stop/i);
    stopping = false;
    assert.equal((await harness.manager.status(harness.spec)).state, 'running');
  } finally {
    stopping = false;
    harness.manager.updateRuntimeSettings({ startupTimeoutMs: 3000, shutdownTimeoutMs: 5000 });
    await harness.manager.stop(harness.spec);
  }
});

test('start automatically evicts stale process record when PID identity does not match', async (t) => {
  const fakeForeignPid = 999999;
  const harness = await makeHarness(t, {
    processOptions: {
      inspectProcess: async (pid) => {
        if (pid === fakeForeignPid) {
          return {
            pid: fakeForeignPid,
            createdAt: '1234567890',
            executablePath: 'C:\\Windows\\System32\\svchost.exe',
            commandLine: 'svchost.exe -k netsvcs',
          };
        }
        return inspectProcess(pid);
      },
    },
  });

  // Seed a stale record with a valid format whose PID belongs to an unrelated system process
  const staleRecord = {
    version: 1,
    id: '11111111-2222-3333-4444-555555555555',
    service: harness.spec.name,
    pid: fakeForeignPid,
    createdAt: '9999999999', // Mismatched creation time
    executablePath: 'C:\\Windows\\System32\\svchost.exe',
    commandLine: 'svchost.exe -k netsvcs',
    workspaceRoot: harness.spec.workspaceRoot,
    entrypoint: harness.spec.entrypoint,
    controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  await writeFile(path.join(harness.paths.runtime, `${harness.spec.name}.json`), JSON.stringify(staleRecord, null, 2));

  // Querying status should still safely report degraded (read-only query does not mutate)
  const status = await harness.manager.status(harness.spec);
  assert.equal(status.state, 'degraded');
  assert.match(status.detail, /identity/i);

  // ServiceManager start should evict the stale degraded service and launch the real process cleanly
  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, new LifecycleLock(harness.paths));
  await serviceManager.start();

  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
  assert.notEqual(statusAfter[0].pid, fakeForeignPid);
});

test('start automatically evicts corrupted process record JSON and recovers', async (t) => {
  const harness = await makeHarness(t);
  // Write corrupted JSON to simulate partial write during unexpected power loss
  await writeFile(path.join(harness.paths.runtime, `${harness.spec.name}.json`), '{ "broken_json": true, ');

  // Status reports degraded on corrupt file
  const status = await harness.manager.status(harness.spec);
  assert.equal(status.state, 'degraded');

  // Start recovers cleanly
  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, new LifecycleLock(harness.paths));
  await serviceManager.start();
  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
});

test('start automatically evicts record belonging to another workspace and recovers', async (t) => {
  const harness = await makeHarness(t);
  const foreignRecord = {
    version: 1,
    id: '22222222-3333-4444-5555-666666666666',
    service: harness.spec.name,
    pid: process.pid,
    createdAt: '1234567890',
    executablePath: process.execPath,
    commandLine: 'node test',
    workspaceRoot: path.resolve('C:\\some\\other\\foreign\\workspace'),
    entrypoint: path.resolve('C:\\some\\other\\foreign\\workspace\\entry.js'),
    controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  await writeFile(path.join(harness.paths.runtime, `${harness.spec.name}.json`), JSON.stringify(foreignRecord, null, 2));

  const status = await harness.manager.status(harness.spec);
  assert.equal(status.state, 'degraded');
  assert.match(status.detail, /workspace/i);

  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, new LifecycleLock(harness.paths));
  await serviceManager.start();
  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
});

test('createDefaultServices configures TRUST_PROXY to true for relay', () => {
  const dummyPaths = paths(os.tmpdir());
  const services = createDefaultServices(dummyPaths, DEFAULT_SETTINGS);
  const relay = services.find((s) => s.name === 'relay');
  assert.ok(relay, 'relay service must exist');
  assert.equal(relay.env.TRUST_PROXY, 'true');
});

test('reused PID belonging to foreign inaccessible system process is evicted and starts cleanly', async (t) => {
  if (process.platform !== 'win32') return;
  const harness = await makeHarness(t);
  // On Windows, PID 4 is always System process.
  // Simulate a leftover record from before reboot whose PID is now 4.
  const foreignRecord = {
    version: 1,
    id: '12345678-1234-4234-8234-123456789abc',
    service: harness.spec.name,
    pid: 4,
    createdAt: '123456789',
    executablePath: process.execPath,
    commandLine: 'node test',
    workspaceRoot: harness.spec.workspaceRoot,
    entrypoint: harness.spec.entrypoint,
    controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  await writeFile(path.join(harness.paths.runtime, `${harness.spec.name}.json`), JSON.stringify(foreignRecord, null, 2));

  // Inspecting status must not crash or degrade: PID 4 returned null from inspector, so status is stopped!
  const status = await harness.manager.status(harness.spec);
  assert.equal(status.state, 'stopped');

  // Start must cleanly evict and start the actual service
  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, new LifecycleLock(harness.paths));
  await serviceManager.start();
  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
  assert.notEqual(statusAfter[0].pid, 4);
});

test('reboot stale record older than system boot time is evicted without health delay', async (t) => {
  const harness = await makeHarness(t, { startupTimeoutMs: 2000 });
  const staleRecord = {
    version: 1,
    id: '12345678-1234-4234-8234-123456789abc',
    service: harness.spec.name,
    pid: 999999,
    createdAt: '123456789',
    executablePath: process.execPath,
    commandLine: 'node fake-service.mjs',
    workspaceRoot: harness.spec.workspaceRoot,
    entrypoint: harness.spec.entrypoint,
    controlPort: 54321,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    bootId: 'stale-boot',
  };
  const recordFile = path.join(harness.paths.runtime, `${harness.spec.name}.json`);
  await writeFile(recordFile, JSON.stringify(staleRecord, null, 2));
  const pastTime = new Date(Date.now() - (os.uptime() * 1000) - 60000);
  const { utimes } = await import('node:fs/promises');
  await utimes(recordFile, pastTime, pastTime);

  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, new LifecycleLock(harness.paths));
  const start = Date.now();
  await serviceManager.start();
  const elapsed = Date.now() - start;

  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
  assert.notEqual(statusAfter[0].pid, 999999);
  assert.ok(elapsed < 1500, `startup took ${elapsed}ms, expected fast eviction under 1500ms`);
});
