import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const shared = new URL('../packages/shared/dist/index.js', import.meta.url).href;
const storeModule = new URL('../packages/shared/dist/diagnostics/adapters/sqlite-log.js', import.meta.url).href;
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-log-wiring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, databasePath: path.join(root, 'data', 'brc-diagnostics.sqlite') };
}

function run(root, databasePath, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: root, BRC_DIAGNOSTICS_DB: databasePath },
  });
}

function trace(command, runId) {
  return {
    traceSchema: 1, runId, command, startedAt: new Date().toISOString(), status: 'ok',
    durationMs: 12, accountedMs: 10, unaccountedMs: 2,
    stages: [{ stage: 'command', status: 'ok', startMs: 0, durationMs: 10 }],
  };
}

function snapshot(instanceId) {
  return {
    schema: 1, service: 'cli', instanceId, pid: process.pid,
    capturedAt: new Date().toISOString(), status: 'running',
    functions: {
      schema: 1, totalCalls: 1, truncated: false, droppedIds: 0,
      entries: [{
        id: 'fn-1', name: 'main', file: 'cli.ts', line: 1, kind: 'sync',
        calls: 1, totalMs: 3, maxMs: 3, asyncWallMs: 0, errors: 0,
      }],
    },
    resources: {
      schema: 1, capturedAt: new Date().toISOString(), source: 'node', windowMs: 100,
      cpuUserMs: 1, cpuSystemMs: 1, cpuPercent: 2, rssBytes: 1024, heapUsedBytes: 512,
    },
  };
}

test('diagnostic store writes events to the same database that diagnose logs queries', async (t) => {
  const { root, databasePath } = await makeRoot(t);
  const { SqliteDiagnosticsStore } = await import(shared);
  const store = new SqliteDiagnosticsStore({ databasePath });
  await store.log.write({
    level: 'info', component: 'cli', source: { file: 'cli.ts', function: 'main' },
    message: 'wired event', runId: 'run-wired', now: new Date('2026-02-01T00:00:00.000Z'),
  });
  store.close();

  const result = run(root, databasePath, 'diagnose', 'logs', '--json', '--run-id', 'run-wired');
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, 'wired event');
});

test('trace records round-trip through the store and are filtered by command', async (t) => {
  const { databasePath } = await makeRoot(t);
  const { SqliteDiagnosticsStore } = await import(storeModule);
  const store = new SqliteDiagnosticsStore({ databasePath });
  assert.equal(store.recordTrace(trace('start', 'run-start')), 1);
  assert.equal(store.recordTrace(trace('stop', 'run-stop')), 1);
  assert.deepEqual(store.queryTraces({ commands: ['start'] }).map((item) => item.runId), ['run-start']);
  assert.deepEqual(store.queryTraces({ commands: ['start', 'stop'], limit: 1 }).map((item) => item.runId), ['run-stop']);
  assert.equal(store.stats().traces, 2);
  store.close();
});

test('diagnose startup reads a trace seeded in SQLite', async (t) => {
  const { root, databasePath } = await makeRoot(t);
  const { SqliteDiagnosticsStore } = await import(storeModule);
  const store = new SqliteDiagnosticsStore({ databasePath });
  const seeded = trace('start', 'run-seeded');
  store.recordTrace(seeded);
  store.close();

  const result = run(root, databasePath, 'diagnose', 'startup', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: 'recorded', summary: seeded });
});

test('diagnose functions reads snapshots written to SQLite', async (t) => {
  const { root, databasePath } = await makeRoot(t);
  const { SqliteDiagnosticsStore } = await import(storeModule);
  const store = new SqliteDiagnosticsStore({ databasePath });
  await store.snapshots.write(snapshot('wire-1'));
  store.close();

  const result = run(root, databasePath, 'diagnose', 'functions', '--json');
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'main');
});

test('multiple processes write diagnostics to one SQLite database without loss', async (t) => {
  const { databasePath } = await makeRoot(t);
  const entry = pathToFileURL(path.resolve('packages/shared/dist/diagnostics/adapters/sqlite-log.js')).href;
  const tasks = Array.from({ length: 3 }, (_, child) => new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', `
      import { SqliteDiagnosticsStore } from '${entry}';
      const store = new SqliteDiagnosticsStore({ databasePath: ${JSON.stringify(databasePath)} });
      for (let index = 0; index < 5; index += 1) {
        await store.log.write({ level: 'info', component: 'cli', source: { file: 'child.ts' }, message: 'm' + index });
      }
      store.recordTrace({ traceSchema: 1, runId: 'child-' + ${child}, command: 'start', startedAt: new Date().toISOString(), status: 'ok', durationMs: 1, accountedMs: 1, unaccountedMs: 0, stages: [] });
      store.close();
    `], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    childProcess.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    childProcess.once('error', reject);
    childProcess.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  }));
  await Promise.all(tasks);
  const { SqliteDiagnosticsStore } = await import(storeModule);
  const store = new SqliteDiagnosticsStore({ databasePath });
  assert.equal(store.stats().events, 15);
  assert.equal(store.queryTraces({ commands: ['start'] }).length, 3);
  store.close();
});
