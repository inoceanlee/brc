import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  DIAGNOSTICS_DB_FILENAME,
  SqliteDiagnosticLog,
  SqliteDiagnosticsStore,
  SqliteRelayAudit,
  SqliteSnapshotStore,
  SqliteToolHistoryStore,
  diagnosticsRetentionConfig,
  resolveDiagnosticsDbPath,
} from '../packages/shared/dist/diagnostics/adapters/sqlite-log.js';

async function makeStore(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-sqlite-'));
  const databasePath = path.join(root, DIAGNOSTICS_DB_FILENAME);
  const config = diagnosticsRetentionConfig();
  const store = new SqliteDiagnosticsStore({ databasePath, config, ...options });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, databasePath, store, config };
}

function snapshot(overrides = {}) {
  return {
    schema: 1,
    service: 'relay',
    instanceId: 'instance-1',
    pid: process.pid,
    capturedAt: new Date().toISOString(),
    status: 'running',
    functions: { schema: 1, totalCalls: 2, entries: [], truncated: false, droppedIds: 0 },
    resources: {
      schema: 1, capturedAt: new Date().toISOString(), source: 'node', windowMs: 100,
      cpuUserMs: 5, cpuSystemMs: 2, cpuPercent: 3.5, rssBytes: 1024, heapUsedBytes: 512,
      peak: { source: 'sampled', rssBytes: 2048, windowMs: 100 },
    },
    ...overrides,
  };
}

test('SQLite diagnostic log writes events and queries them by filter', async (t) => {
  const { store } = await makeStore(t);
  const base = { component: 'cli', source: { file: 'cli.ts' }, level: 'info' };
  await store.log.write({ ...base, message: 'one', runId: 'run-a', now: new Date('2026-11-01T00:00:00Z') });
  await store.log.write({
    ...base, level: 'error', message: 'two', runId: 'run-b',
    source: { file: 'relay.ts', function: 'serve' }, now: new Date('2026-11-02T00:00:00Z'),
  });
  await store.log.write({ ...base, message: 'three', runId: 'run-a', now: new Date('2026-11-03T00:00:00Z') });

  assert.equal((await store.query.query()).length, 3);
  assert.equal((await store.query.query({ runId: 'run-a' })).length, 2);
  assert.equal((await store.query.query({ level: 'error' })).length, 1);
  assert.equal((await store.query.query({ source: 'relay.ts' })).length, 1);
  assert.equal((await store.query.query({ since: '2026-11-02T00:00:00Z' })).length, 2);
  assert.equal((await store.query.query({ until: '2026-11-01T12:00:00Z' })).length, 1);
  const limited = await store.query.query({ level: 'info', runId: 'run-a', limit: 1 });
  assert.equal(limited.length, 1);
  const decoded = await store.query.query({ source: 'serve' });
  assert.equal(decoded[0].source.function, 'serve');
});

test('SQLite snapshots persist across connections and classify states', async (t) => {
  const { store } = await makeStore(t);
  const now = new Date('2026-11-15T12:00:00Z');
  const options = { database: store.database, now: () => now, staleAfterMs: 1_000, isAlive: () => true };
  const snapshots = new SqliteSnapshotStore(options);
  await snapshots.write(snapshot({ capturedAt: now.toISOString() }));
  assert.equal((await snapshots.read('relay', 'instance-1')).state, 'current');

  const reopened = new SqliteSnapshotStore(options);
  assert.equal((await reopened.read('relay', 'instance-1')).snapshot.pid, process.pid);
  await reopened.write(snapshot({
    instanceId: 'gone', status: 'exited', capturedAt: new Date(now.getTime() - 60_000).toISOString(),
  }));
  assert.equal((await reopened.read('relay', 'gone')).state, 'exited');
  assert.equal((await reopened.list()).length, 2);
  assert.equal(await reopened.prune(10_000, () => false), 1);
  assert.equal((await reopened.read('relay', 'gone')).state, 'missing');
});

test('diagnostic writes wait out a writer lock longer than five seconds', async (t) => {
  const { databasePath, store } = await makeStore(t);
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 6000);
  `, databasePath], { stdio: 'ignore' });
  t.after(() => { if (!holder.killed) holder.kill(); });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await store.log.write({ level: 'info', component: 'cli', source: { file: 'test' }, message: 'after long lock' });
});

test('SQLite retention and rotation prune expired rows and bound table size', async (t) => {
  const config = {
    ...diagnosticsRetentionConfig(),
    eventsRetentionDays: 1,
    historyRetentionDays: 1,
    auditRetentionDays: 1,
    auditMaxEntries: 3,
  };
  const { store } = await makeStore(t, { config });
  const old = new Date(Date.now() - 10 * 86_400_000);
  await store.log.write({ level: 'info', component: 'cli', source: { file: 'x.ts' }, message: 'old', now: old });
  await store.log.write({ level: 'info', component: 'cli', source: { file: 'x.ts' }, message: 'new' });
  for (let index = 0; index < 8; index += 1) {
    await store.audit.append({ ts: index === 0 ? old.getTime() : Date.now(), tool: `t${index}`, ok: true });
  }
  await store.history.append({
    timestamp: old.toISOString(), toolName: 'h', arguments: {}, output: { isError: false, content: [] },
  });

  assert.equal(store.stats().events, 2);
  assert.equal(store.stats().audit, 8);
  const result = store.maintain();
  assert.equal(result.events, 1);
  assert.equal(result.audit, 5);
  assert.equal(result.history, 1);
  assert.equal(result.rotated, false);
  assert.equal(store.stats().events, 1);
  assert.equal(store.stats().audit, 3);
  assert.equal(store.stats().history, 0);
});

test('SQLite rotation bounds database size when the configured cap is exceeded', async (t) => {
  const config = { ...diagnosticsRetentionConfig(), maxDatabaseMiB: 0.001 };
  const { store } = await makeStore(t, { config });
  for (let index = 0; index < 6; index += 1) {
    await store.log.write({
      level: 'info', component: 'cli', source: { file: 'x.ts' }, message: 'payload '.repeat(8),
    });
  }
  assert.equal(store.stats().events, 6);
  const result = store.maintain();
  assert.equal(result.rotated, true);
  assert.ok(store.stats().events <= 6);
});

test('multiple processes write to one SQLite database without loss', async (t) => {
  const { databasePath, store } = await makeStore(t);
  store.close();
  const entry = pathToFileURL(path.resolve('packages/shared/dist/diagnostics/adapters/sqlite-log.js')).href;
  const tasks = Array.from({ length: 4 }, (_, child) => new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', `
      import { SqliteDiagnosticLog } from '${entry}';
      const log = new SqliteDiagnosticLog({ databasePath: ${JSON.stringify(databasePath)} });
      for (let index = 0; index < 10; index += 1) {
        await log.write({ level: 'info', component: 'cli', source: { file: 'child.ts' }, message: 'm' + index });
      }
      log.close();
    `], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    childProcess.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    childProcess.once('error', reject);
    childProcess.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  }));
  await Promise.all(tasks);
  const reopened = new SqliteDiagnosticsStore({ databasePath });
  assert.equal(reopened.stats().events, 40);
  reopened.close();
});

test('tool history and relay audit share the database without identity tables', async (t) => {
  const { databasePath, store } = await makeStore(t);
  assert.ok(store.history instanceof SqliteToolHistoryStore);
  assert.ok(store.audit instanceof SqliteRelayAudit);
  assert.ok(store.log instanceof SqliteDiagnosticLog);
  await store.history.append({
    timestamp: new Date().toISOString(), toolName: 'search', arguments: {},
    output: { isError: false, content: ['ok'] }, duration: 12,
  });
  await store.audit.append({
    tool: 'search', ok: false, error: 'boom', userId: 'u1', deviceId: 'd1', client: 'cli',
  });

  const db = new DatabaseSync(databasePath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  db.close();
  assert.ok(tables.includes('tool_history'));
  assert.ok(tables.includes('relay_audit'));
  assert.ok(!tables.includes('users'));
  assert.ok(!tables.includes('audit'));
  assert.equal(store.stats().history, 1);
  assert.equal(store.stats().audit, 1);
  assert.equal((await store.history.query({ toolName: 'search' })).length, 1);
  assert.equal((await store.history.query({ toolName: 'missing' })).length, 0);
});

test('database path resolver uses data directory and environment override', () => {
  const dataDirectory = path.join(os.tmpdir(), 'brc-data');
  assert.equal(resolveDiagnosticsDbPath(dataDirectory), path.join(dataDirectory, DIAGNOSTICS_DB_FILENAME));
  const override = path.join(os.tmpdir(), 'custom-diagnostics.sqlite');
  assert.equal(resolveDiagnosticsDbPath(dataDirectory, { BRC_DIAGNOSTICS_DB: override }), override);
});
