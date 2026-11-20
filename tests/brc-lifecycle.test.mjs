import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessManager, inspectProcess } from '../packages/cli/dist/adapters/process/controller.js';
import { inspectProcesses } from '../packages/cli/dist/adapters/process/identity.js';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { cleanRuntime as runCleanup } from '../packages/cli/dist/adapters/storage/cleanup.js';
import { LifecycleLock as LifecycleLockImpl } from '../packages/cli/dist/adapters/storage/lock.js';
import { startManagedControlServer } from '../packages/shared/dist/managed-control.js';
import { LockStore } from '../packages/cli/dist/adapters/storage/lock-store.js';
import { FileSnapshotStore } from '../packages/shared/dist/diagnostics/adapters/snapshots.js';

function LifecycleLock(paths, options) {
  return new LifecycleLockImpl(paths, new LockStore(paths), options);
}

function cleanRuntime(paths, options = {}) {
  return runCleanup(paths, options, {
    lockStore: new LockStore(paths),
    lifecycleLock: new LifecycleLock(paths, {
      waitMs: options.settings?.runtime.lockWaitMs,
      pollMs: options.settings?.runtime.lockPollMs,
    }),
    snapshotStore: new FileSnapshotStore({ directory: paths.diagnostics ?? path.join(paths.root, 'diagnostics') }),
    createProcessManager: (options) => new ProcessManager(paths, options),
  });
}

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
    if (process.env.BRC_TEST_SHUTDOWN_TRACE) appendFileSync(process.env.BRC_TEST_SHUTDOWN_TRACE, 'shutdown\\n');
    if (mode === 'shutdown-error') res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { message: 'cleanup failed' } }));
    else if (mode === 'legacy-shutdown') res.writeHead(202).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
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

test('manager reports a service shutdown failure after process exit', async (t) => {
  const harness = await makeHarness(t, { mode: 'shutdown-error' });
  await harness.manager.start(harness.spec);
  await assert.rejects(harness.manager.stop(harness.spec), /cleanup failed/);
});

test('manager receives the managed service shutdown deadline response', { timeout: 10000 }, async (t) => {
  const harness = await makeHarness(t, { shutdownTimeoutMs: 300 });
  const sharedUrl = new URL('../packages/shared/dist/managed-control.js', import.meta.url).href;
  await writeFile(harness.entrypoint, `
    import { createServer } from 'node:http';
    import { startManagedControlServer } from ${JSON.stringify(sharedUrl)};
    await startManagedControlServer({
      server: createServer(),
      token: process.env.BRC_CONTROL_TOKEN,
      readyFile: process.env.BRC_CONTROL_READY_FILE,
      id: process.env.BRC_MANAGED_ID,
      service: process.env.BRC_MANAGED_SERVICE,
      shutdownTimeoutMs: 300,
      health: () => ({ state: 'running', detail: 'ready' }),
      stop: () => new Promise(() => {}),
      onStopError: () => { process.exitCode = 1; },
    });
  `);
  try {
    await harness.manager.start(harness.spec);
    await assert.rejects(harness.manager.stop(harness.spec), (error) =>
      /HTTP 500/.test(error.message) && /deadline/.test(error.message));
  } finally {
    try { await harness.manager.stop(harness.spec); } catch (error) {
      if ((await harness.manager.status(harness.spec)).state !== 'stopped') throw error;
    }
  }
});

test('manager rejects the legacy accepted-only shutdown response', async (t) => {
  const harness = await makeHarness(t, { mode: 'legacy-shutdown' });
  await harness.manager.start(harness.spec);
  await assert.rejects(harness.manager.stop(harness.spec), /shutdown was not confirmed/);
});

test('batch inspection validates and deduplicates process IDs', async () => {
  assert.deepEqual(await inspectProcesses([]), new Map());
  await assert.rejects(inspectProcesses([process.pid, 0]), /Invalid process ID/);
  const identities = await inspectProcesses([process.pid, process.pid, 2147483647]);
  assert.equal(identities.size, 2);
  assert.equal(identities.get(process.pid)?.pid, process.pid);
  assert.equal(identities.get(2147483647), null);
});

test('process inspection honors cancellation before launching an inspector', async () => {
  const controller = new AbortController();
  controller.abort(new Error('inspection cancelled'));
  await assert.rejects(inspectProcesses([process.pid], controller.signal), /inspection cancelled/);
});

test('macOS inspection reports a missing PID as exited', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(await inspectProcess(2147483647), null);
});

test('Linux zombie is treated as exited without signaling its parent', { skip: process.platform !== 'linux' }, async (t) => {
  if (spawnSync('python3', ['--version']).error) return t.skip('python3 is unavailable');
  const parent = spawn('python3', ['-c', 'import os,sys\np=os.fork()\nif p==0: os._exit(0)\nprint(p, flush=True)\nsys.stdin.readline()\nos.waitpid(p,0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { parent.stdin.end('\n'); });
  const [chunk] = await once(parent.stdout, 'data');
  const pid = Number(chunk.toString().trim());
  const harness = await makeHarness(t, { processOptions: { inspectProcess: async () => null } });
  const filename = path.join(harness.paths.runtime, 'relay.json');
  await writeFile(filename, JSON.stringify({
    version: 1, service: 'relay', id: '12345678-1234-4234-8234-123456789abc', pid,
    createdAt: 'old', executablePath: process.execPath, commandLine: 'old',
    workspaceRoot: harness.root, entrypoint: harness.entrypoint, controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }));
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break;
    await sleep(10);
  }
  const record = await readFile(filename, 'utf8');
  await cleanRuntime(harness.paths);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  await writeFile(filename, record);
  await harness.manager.stop(harness.spec);
  await assert.rejects(readFile(filename), { code: 'ENOENT' });
  assert.equal(parent.exitCode, null);
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

test('start preserves a live record when ownership cannot be proved', async (t) => {
  const harness = await makeHarness(t);
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(filename, 'utf8');
  const changed = { ...JSON.parse(original), commandLine: 'unverifiable command' };
  await writeFile(filename, JSON.stringify(changed));
  try {
    await assert.rejects(harness.manager.start(harness.spec), /identity|conflict/i);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), changed);
    process.kill(changed.pid, 0);
  } finally {
    await writeFile(filename, original);
  }
});

test('creation time mismatch alone does not authorize replacing a live service', async (t) => {
  const harness = await makeHarness(t);
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(filename, 'utf8');
  const altered = { ...JSON.parse(original), createdAt: 'corrupted-creation-time' };
  await writeFile(filename, JSON.stringify(altered));
  try {
    const manager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
    await assert.rejects(manager.start(), (error) => error.exitCode === 5 && /relay/i.test(error.message));
    await assert.rejects(manager.stop(), (error) => error.exitCode === 5 && /relay/i.test(error.message));
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), altered);
    process.kill(altered.pid, 0);
  } finally {
    await writeFile(filename, original);
  }
});

test('multiple damaged identity fields do not authorize replacement of a live service', async (t) => {
  const harness = await makeHarness(t);
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(filename, 'utf8');
  const altered = { ...JSON.parse(original), id: '11111111-2222-3333-4444-555555555555', createdAt: 'corrupt', commandLine: 'damaged' };
  await writeFile(filename, JSON.stringify(altered));
  try {
    await assert.rejects(harness.manager.start(harness.spec), (error) => error.exitCode === 5);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), altered);
    process.kill(altered.pid, 0);
  } finally {
    await writeFile(filename, original);
  }
});

test('identity inspection failure during shutdown retains record and reports conflict', async (t) => {
  let shutdown = false;
  let inspected = false;
  const harness = await makeHarness(t, { mode: 'hang', processOptions: { inspectProcess: async (pid) => {
    if (shutdown && inspected) throw new Error('inspection failed');
    if (shutdown) inspected = true;
    return inspectProcess(pid);
  }}});
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(filename, 'utf8');
  shutdown = true;
  try {
    await assert.rejects(harness.manager.stop(harness.spec), (error) => error.exitCode === 5 && /inspection failed/.test(error.message));
    assert.equal(await readFile(filename, 'utf8'), original);
    process.kill(JSON.parse(original).pid, 0);
  } finally {
    shutdown = false;
  }
});

test('timeout after a stop failure keeps the failure and does not become cancellation', async () => {
  const controller = new AbortController();
  const processes = {
    status: async (spec) => ({ name: spec.name, state: 'running', pid: 1, detail: '' }),
    stop: async (spec) => {
      if (spec.name === 'agent') throw new Error('agent failed');
      controller.abort(new Error('command timed out'));
      throw new Error('traefik stop failed');
    },
  };
  const services = ['traefik', 'agent'].map((name) => ({ name, entrypoint: '/test', workspaceRoot: '/', cwd: '/' }));
  const manager = new ServiceManager(paths(os.tmpdir()), services, processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });
  await assert.rejects(manager.stop(controller.signal), (error) => error.exitCode !== 130 && /agent failed/.test(error.message) && /traefik stop failed/.test(error.message));
});

test('timeout during status preserves each earlier failure once', async () => {
  const controller = new AbortController();
  const processes = {
    status: async (spec) => {
      if (spec.name === 'traefik') controller.abort(new Error('command timed out'));
      return { name: spec.name, state: 'running', pid: 1, detail: '' };
    },
    stop: async () => { throw new Error('agent failed'); },
  };
  const services = ['traefik', 'agent'].map((name) => ({ name, entrypoint: '/test', workspaceRoot: '/', cwd: '/' }));
  const manager = new ServiceManager(paths(os.tmpdir()), services, processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });
  await assert.rejects(manager.stop(controller.signal), (error) => error.exitCode === 1 && (error.message.match(/agent failed/g) ?? []).length === 1 && !error.message.includes('traefik:'));
});

test('repeated service stop does not invoke process stop for stopped services', async () => {
  let calls = 0;
  const processes = {
    status: async (spec) => ({ name: spec.name, state: 'stopped', pid: null, detail: 'No managed process record.' }),
    stop: async () => { calls++; },
  };
  const manager = new ServiceManager(paths(os.tmpdir()), [{ name: 'relay', entrypoint: '/test', workspaceRoot: '/', cwd: '/' }], processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });
  await manager.stop();
  await manager.stop();
  assert.equal(calls, 0);
});

test('stop retains earlier failures when cancellation interrupts later services', async () => {
  const controller = new AbortController();
  const services = ['relay', 'traefik', 'agent'].map((name) => ({ name, entrypoint: '/test', workspaceRoot: '/', cwd: '/' }));
  const processes = {
    status: async (spec) => ({ name: spec.name, state: 'running', pid: 1, detail: '' }),
    stop: async (spec) => {
      if (spec.name === 'agent') throw new Error('agent shutdown failed');
      controller.abort(Object.assign(new Error('cancelled'), { exitCode: 130 }));
    },
  };
  const manager = new ServiceManager(paths(os.tmpdir()), services, processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });
  await assert.rejects(manager.stop(controller.signal), (error) => error.exitCode === 130 && /agent shutdown failed/.test(error.message));
});

test('start preserves malformed records instead of replacing them', async (t) => {
  const harness = await makeHarness(t);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  await writeFile(filename, '{broken');
  await assert.rejects(harness.manager.start(harness.spec), /malformed|JSON/i);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
  await rm(filename);
});

test('cancelling shutdown preserves the record and does not force-stop the process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-stop-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = path.join(root, 'shutdown');
  const harness = await makeHarness(t, { mode: 'hang', shutdownTimeoutMs: 5000, env: { BRC_TEST_SHUTDOWN_TRACE: trace } });
  await harness.manager.start(harness.spec);
  const recordFile = path.join(harness.paths.runtime, 'relay.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const controller = new AbortController();
  const stopping = harness.manager.stop(harness.spec, controller.signal);
  for (let i = 0; i < 100; i++) {
    try { await readFile(trace); break; } catch { await sleep(20); }
  }
  assert.equal(await readFile(trace, 'utf8'), 'shutdown\n');
  controller.abort(new Error('stop cancelled'));
  await assert.rejects(stopping, /stop cancelled|abort/i);
  assert.deepEqual(JSON.parse(await readFile(recordFile, 'utf8')), record);
  process.kill(record.pid, 0);
  harness.manager.updateRuntimeSettings({ startupTimeoutMs: 3000, shutdownTimeoutMs: 300 });
});

test('service stop forwards cancellation and does not stop later services', async () => {
  const controller = new AbortController();
  const stopped = [];
  const services = ['relay', 'agent'].map((name) => ({ name, entrypoint: '/test', workspaceRoot: '/', cwd: '/' }));
  const processes = {
    status: async (spec, signal) => {
      assert.equal(signal, controller.signal);
      return { name: spec.name, state: 'running', pid: 1, detail: '' };
    },
    stop: async (spec, signal) => {
      stopped.push(spec.name);
      assert.equal(signal, controller.signal);
      controller.abort(new Error('stop cancelled'));
    },
  };
  const manager = new ServiceManager(paths(os.tmpdir()), services, processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });
  await assert.rejects(manager.stop(controller.signal), /stop cancelled/);
  assert.deepEqual(stopped, ['agent']);
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
  assert.deepEqual(await harness.manager.check(harness.spec), { ready: true, detail: 'Awaiting device approval.' });
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

  async check(spec, signal) {
    signal?.throwIfAborted();
    const status = this.states.get(spec.name) ?? { state: 'stopped', detail: 'not started' };
    return { ready: status.state === 'running' || status.state === 'pairing', detail: status.detail };
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
      server: createServer(),
      token: env.BRC_CONTROL_TOKEN,
      readyFile: env.BRC_CONTROL_READY_FILE,
      id: env.BRC_MANAGED_ID,
      service: env.BRC_MANAGED_SERVICE,
      onStopError: (error) => { throw error; },
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
    const response = await fetch(`${endpoint}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    });
    assert.equal(response.status, 200);
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

test('managed control sends shutdown failures to its supplied error handler', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let report;
  const failure = new Promise((resolve) => { report = resolve; });
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'a'.repeat(64),
    readyFile: path.join(root, 'relay.ready.json'),
    id: '00000000-0000-4000-8000-000000000001',
    service: 'relay',
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => { throw new AggregateError([new Error('shutdown timeout'), new Error('flush failed')], 'cleanup failed'); },
    onStopError: (error) => report(error),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
    });
    assert.equal(response.status, 500);
    const message = (await response.json()).error.message;
    assert.match(message, /shutdown timeout/);
    assert.match(message, /flush failed/);
    assert.match((await failure).message, /cleanup failed/);
  } finally {
    await control.close();
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
  const manager = new ServiceManager(runtimePaths, workspaceServices(root), processes, processes, new LifecycleLock(runtimePaths));

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
  const manager = new ServiceManager(paths(root), workspaceServices(root), processes, processes, new LifecycleLock(paths(root)));
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
  const manager = new ServiceManager(runtimePaths, initial, processes, processes, lock, async () => {
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
import { ServiceManager } from ${JSON.stringify(new URL('../packages/cli/dist/core/lifecycle/workflow.js', import.meta.url).href)};
import { createDefaultServices } from ${JSON.stringify(new URL('../packages/cli/dist/adapters/process/specs.js', import.meta.url).href)};
import { LifecycleLock } from ${JSON.stringify(new URL('../packages/cli/dist/adapters/storage/lock.js', import.meta.url).href)};
import { LockStore } from ${JSON.stringify(new URL('../packages/cli/dist/adapters/storage/lock-store.js', import.meta.url).href)};
const paths = resolveBrcPaths(process.env);
const initial = await readSettings(paths, process.env);
if (initial.settings.services.relayPort !== 13000) throw new Error('initial settings were not loaded');
const relayServices = (settings) => createDefaultServices(paths, settings, process.env).filter((service) => service.name === 'relay');
const states = new Map();
const processes = {
  async status(spec) { return states.get(spec.name) ?? { name: spec.name, state: 'stopped', pid: null, detail: 'not started' }; },
  async check(spec) { const status = await this.status(spec); return { ready: status.state === 'running' || status.state === 'pairing', detail: status.detail }; },
  async start(spec) {
    await writeFile(${JSON.stringify(portFile)}, spec.env.PORT);
    states.set(spec.name, { name: spec.name, state: 'running', pid: 100, detail: 'healthy' });
  },
  async stop(spec) { states.set(spec.name, { name: spec.name, state: 'stopped', pid: null, detail: 'stopped' }); },
};
const lock = new LifecycleLock(paths, new LockStore(paths));
const manager = new ServiceManager(paths, relayServices(initial.settings), processes, processes, lock, async () => {
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
  const manager = new ServiceManager(paths(root), workspaceServices(root), processes, processes, new LifecycleLock(paths(root)));

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
  const first = new ServiceManager(runtimePaths, services, processes, processes, new LifecycleLock(runtimePaths, { waitMs: 10_000 }));
  const second = new ServiceManager(runtimePaths, services, processes, processes, new LifecycleLock(runtimePaths, { waitMs: 10_000 }));

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
  const first = new ServiceManager(runtimePaths, services, processes, processes, lock);
  const second = new ServiceManager(runtimePaths, services, processes, processes, lock);

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

    const lockUrl = new URL('../packages/cli/dist/adapters/storage/lock.js', import.meta.url).href;
    const source = `
      import { LifecycleLock } from ${JSON.stringify(lockUrl)};
      import { LockStore } from ${JSON.stringify(new URL('../packages/cli/dist/adapters/storage/lock-store.js', import.meta.url).href)};
      await new LifecycleLock(${JSON.stringify(runtimePaths)}, new LockStore(${JSON.stringify(runtimePaths)})).runExclusive(async () => {});
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
  const processManagerUrl = JSON.stringify(new URL('../packages/cli/dist/adapters/process/controller.js', import.meta.url).href);
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
  try {
    await harness.manager.start(harness.spec);
    await harness.manager.start(neighbor);
    const neighborRecord = await harness.manager.status(neighbor);
    await assert.rejects(harness.manager.stop(harness.spec), /forcibly stopped/i);
    assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
    const neighborStatus = await harness.manager.status(neighbor);
    assert.equal(neighborStatus.pid, neighborRecord.pid);
    assert.equal(neighborStatus.state, 'running');
  } finally {
    try {
      await harness.manager.stop(neighbor);
    } finally {
      try { await harness.manager.stop(harness.spec); } catch (error) {
        if ((await harness.manager.status(harness.spec)).state !== 'stopped') throw error;
      }
    }
  }
});

test('cancellation after a forced signal reports unconfirmed exit and preserves the record', async (t) => {
  const cancellation = new AbortController();
  let stopping = false;
  const harness = await makeHarness(t, {
    mode: 'hang',
    shutdownTimeoutMs: 500,
    processOptions: {
      inspectProcess: async (pid) => {
        const identity = await inspectProcess(pid);
        if (stopping && !identity) cancellation.abort(new Error('stop cancelled'));
        return identity;
      },
    },
  });
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  try {
    stopping = true;
    await assert.rejects(harness.manager.stop(harness.spec, cancellation.signal), (error) =>
      /forced termination signal was sent/.test(error.message)
      && /exit is not yet confirmed/.test(error.message)
      && /stop cancelled/.test(error.message));
    assert.ok(await readFile(filename, 'utf8'));
  } finally {
    stopping = false;
    try { await harness.manager.stop(harness.spec); } catch (error) {
      if ((await harness.manager.status(harness.spec)).state !== 'stopped') throw error;
    }
  }
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
    await assert.rejects(harness.manager.stop(harness.spec), /forcibly stopped/i);
  }
});

test('start and stop preserve an old record when the PID identity differs', async (t) => {
  const fakeForeignPid = 999999;
  const foreignExecutable = process.platform === 'win32' ? 'C:\\Windows\\System32\\svchost.exe' : '/usr/sbin/sshd';
  const harness = await makeHarness(t, {
    processOptions: {
      inspectProcess: async (pid) => {
        if (pid === fakeForeignPid) {
          return {
            pid: fakeForeignPid,
            createdAt: '1234567890',
            executablePath: foreignExecutable,
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
    executablePath: foreignExecutable,
    commandLine: `node ${harness.spec.entrypoint} --brc-managed-id=11111111-2222-3333-4444-555555555555`,
    workspaceRoot: harness.spec.workspaceRoot,
    entrypoint: harness.spec.entrypoint,
    controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  await writeFile(path.join(harness.paths.runtime, `${harness.spec.name}.json`), JSON.stringify(staleRecord, null, 2));
  const { utimes } = await import('node:fs/promises');
  const previousBoot = new Date(Date.now() - os.uptime() * 1000 - 60_000);
  await utimes(path.join(harness.paths.runtime, 'relay.json'), previousBoot, previousBoot);

  // Querying status should still safely report degraded (read-only query does not mutate)
  const status = await harness.manager.status(harness.spec);
  assert.equal(status.state, 'degraded');
  assert.match(status.detail, /identity/i);

  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
  await assert.rejects(serviceManager.stop(), (error) => error.exitCode === 5);
  await assert.rejects(serviceManager.start(), (error) => error.exitCode === 5);
  assert.deepEqual(JSON.parse(await readFile(path.join(harness.paths.runtime, 'relay.json'), 'utf8')), staleRecord);
  await rm(path.join(harness.paths.runtime, 'relay.json'));
});

test('service start preserves a corrupted process record', async (t) => {
  const harness = await makeHarness(t);
  const filename = path.join(harness.paths.runtime, `${harness.spec.name}.json`);
  const contents = '{ "broken_json": true, ';
  await writeFile(filename, contents);
  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
  await assert.rejects(serviceManager.start(), /Cannot start/);
  assert.equal(await readFile(filename, 'utf8'), contents);
  await rm(filename);
});

test('service start preserves a record belonging to another workspace', async (t) => {
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

  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
  await assert.rejects(serviceManager.start(), /workspace/i);
  assert.deepEqual(JSON.parse(await readFile(path.join(harness.paths.runtime, 'relay.json'), 'utf8')), foreignRecord);
  await rm(path.join(harness.paths.runtime, 'relay.json'));
});

test('createDefaultServices trusts one loopback proxy hop for relay', () => {
  const dummyPaths = paths(os.tmpdir());
  const services = createDefaultServices(dummyPaths, DEFAULT_SETTINGS);
  const relay = services.find((s) => s.name === 'relay');
  assert.ok(relay, 'relay service must exist');
  assert.equal(relay.env.TRUST_PROXY, 'loopback');
});

test('start preserves a live process record when inspection returns no identity', async (t) => {
  const harness = await makeHarness(t, { processOptions: { inspectProcess: async () => null } });
  const record = {
    version: 1,
    id: '12345678-1234-4234-8234-123456789abc',
    service: harness.spec.name,
    pid: process.pid,
    createdAt: '123456789',
    executablePath: process.execPath,
    commandLine: 'node test',
    workspaceRoot: harness.spec.workspaceRoot,
    entrypoint: harness.spec.entrypoint,
    controlPort: 12345,
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const filename = path.join(harness.paths.runtime, 'relay.json');
  await writeFile(filename, JSON.stringify(record));
  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
  assert.equal((await harness.manager.status(harness.spec)).state, 'degraded');
  await assert.rejects(harness.manager.start(harness.spec), /identity/i);
  await assert.rejects(harness.manager.stop(harness.spec), /identity/i);
  await assert.rejects(serviceManager.start(), /identity/i);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), record);
  await rm(filename);
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

  const serviceManager = new ServiceManager(harness.paths, [harness.spec], harness.manager, harness.manager, new LifecycleLock(harness.paths));
  const start = Date.now();
  await serviceManager.start();
  const elapsed = Date.now() - start;

  const statusAfter = await serviceManager.status();
  assert.equal(statusAfter[0].state, 'running');
  assert.notEqual(statusAfter[0].pid, 999999);
  assert.ok(elapsed < 1500, `startup took ${elapsed}ms, expected fast eviction under 1500ms`);
});


test('pnpm upgrade keeps an authenticated running service owned across installation paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-upgrade-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  await mkdir(runtimePaths.runtime, { recursive: true });
  const oldRoot = path.join(root, 'pnpm-store-old');
  const newRoot = path.join(root, 'pnpm-store-new');
  const oldEntry = path.join(oldRoot, 'dist', 'cli.js');
  const newEntry = path.join(newRoot, 'dist', 'cli.js');
  const id = '77777777-2222-4333-8444-555555555555';
  const token = 'a'.repeat(64);
  const commandLine = `"${process.execPath}" "${oldEntry}" --brc-managed-id=${id}`;
  const identity = { pid: 456789, createdAt: '12345678', executablePath: process.execPath, commandLine };
  const control = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, state: 'running', detail: 'ready' }));
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => control.close(resolve)));
  const record = {
    ...identity, version: 1, id, service: 'relay',
    workspaceRoot: oldRoot, entrypoint: oldEntry,
    controlPort: control.address().port, controlToken: token,
  };
  await writeFile(path.join(runtimePaths.runtime, 'relay.json'), JSON.stringify(record));
  const manager = new ProcessManager(runtimePaths, { inspectProcess: async () => identity });
  const status = await manager.status(service('relay', newEntry, newRoot));
  assert.equal(status.state, 'running', status.detail);
  assert.equal(status.pid, identity.pid);
});

test('lifecycle lock cancels a queued waiter without running its operation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const lock = new LifecycleLock(runtimePaths, { waitMs: 2_000, pollMs: 10 });
  let release;
  let entered = false;
  let secondRan = false;
  const first = lock.runExclusive(async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
  });
  while (!entered) await sleep(5);
  const controller = new AbortController();
  const second = lock.runExclusive(async () => { secondRan = true; }, controller.signal);
  controller.abort(new Error('queued lifecycle operation cancelled'));
  await assert.rejects(second, /queued lifecycle operation cancelled/);
  release();
  await first;
  assert.equal(secondRan, false);
});

test('aborted service startup kills its child and removes the process record', async (t) => {
  const harness = await makeHarness(t, {
    startupTimeoutMs: 5000,
    env: { BRC_TEST_READY_BEFORE_READY_DELAY: '1000' },
  });
  const controller = new AbortController();
  const starting = harness.manager.start(harness.spec, controller.signal);
  await sleep(100);
  controller.abort(new Error('service startup cancelled'));
  await assert.rejects(starting, /service startup cancelled/);
  await assert.rejects(readFile(path.join(harness.paths.runtime, 'relay.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
});

test('service manager requires and executes the injected health-check port', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-health-port-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new FakeProcessManager();
  const healthCheck = {
    async check(spec) { return { ready: false, detail: `${spec.name} health rejected` }; },
  };
  const manager = new ServiceManager(paths(root), [service('relay', path.join(root, 'relay.js'), root)], processes, healthCheck, new LifecycleLock(paths(root)));
  await assert.rejects(manager.start(), /control health check: relay health rejected/);
  assert.deepEqual(processes.calls, ['start:relay', 'stop:relay']);
});
