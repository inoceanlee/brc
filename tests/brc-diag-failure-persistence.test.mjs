import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DIAGNOSTICS_DB_FILENAME, SqliteDiagnosticsStore, diagnosticsRetentionConfig } from '../packages/shared/dist/diagnostics/adapters/sqlite-log.js';

function makeSnapshot(failures) {
  const now = new Date().toISOString();
  return {
    schema: 1,
    service: 'agent',
    instanceId: 'agent-fail-1',
    pid: process.pid,
    capturedAt: now,
    status: 'running',
    functions: { schema: 1, totalCalls: 1, entries: [], truncated: false, droppedIds: 0, failures },
    resources: {
      schema: 1, capturedAt: now, source: 'node', windowMs: 100,
      cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssBytes: 1, heapUsedBytes: 1,
      peak: null,
    },
  };
}

test('failure samples persist as error events and are written once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-fail-persist-'));
  const store = new SqliteDiagnosticsStore({
    databasePath: path.join(root, DIAGNOSTICS_DB_FILENAME),
    config: diagnosticsRetentionConfig(),
  });
  try {
    const failures = [{ id: 'fn-a', message: 'boom happened', stack: 'Error: boom happened\n  at fn-a' }];
    const snapshot = makeSnapshot(failures);
    await store.snapshots.write(snapshot);
    await store.snapshots.write(snapshot);

    const events = await store.query.query({ level: 'error', component: 'agent' });
    assert.equal(events.length, 1, 'one error event per failure despite repeated snapshots');
    assert.equal(events[0].errorCode, 'FUNCTION_ERROR');
    assert.match(events[0].message, /boom happened/);
    assert.match(events[0].stack, /fn-a/);
    assert.equal(events[0].source.function, 'fn-a');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
