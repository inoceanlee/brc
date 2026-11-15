import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileSnapshotStore } from '../packages/shared/dist/diagnostics/adapters/snapshots.js';

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

async function store(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new FileSnapshotStore({ directory: root, ...overrides }) };
}

test('snapshot write is atomic and readable as current', async (t) => {
  const { root, store: snapshots } = await store(t);
  await snapshots.write(snapshot());
  const files = await readdir(root);
  assert.deepEqual(files, ['relay-instance-1.json']);
  const result = await snapshots.read('relay', 'instance-1');
  assert.equal(result.state, 'current');
  assert.equal(result.snapshot.pid, process.pid);
});

test('snapshot readers distinguish exited, stale, corrupt and missing records', async (t) => {
  const now = new Date('2026-11-15T12:00:00Z');
  const { root, store: snapshots } = await store(t, { staleAfterMs: 1_000, now: () => now });
  await snapshots.write(snapshot({ instanceId: 'gone', pid: 999_999 }));
  await snapshots.write(snapshot({ instanceId: 'old', capturedAt: new Date(now.getTime() - 5_000).toISOString() }));
  await writeFile(path.join(root, 'agent-broken.json'), '{not json');
  await writeFile(path.join(root, 'unknown-file.txt'), 'ignored');
  assert.equal((await snapshots.read('relay', 'missing')).state, 'missing');
  assert.equal((await snapshots.read('relay', 'gone')).state, 'exited');
  assert.equal((await snapshots.read('relay', 'old')).state, 'stale');
  assert.equal((await snapshots.read('agent', 'broken')).reason, 'invalid-json');
  const listed = await snapshots.list();
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((item) => item.state).sort(),
    ['corrupt', 'exited', 'stale'],
  );
});

test('concurrent snapshot writers never expose partial JSON', async (t) => {
  const { store: snapshots } = await store(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => snapshots.write(snapshot({
    functions: { schema: 1, totalCalls: index, entries: [], truncated: false, droppedIds: 0 },
  }))));
  const result = await snapshots.read('relay', 'instance-1');
  assert.equal(result.state, 'current');
  assert.ok(result.snapshot.functions.totalCalls >= 0 && result.snapshot.functions.totalCalls < 20);
});

test('oversized snapshots drop entries and report truncation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-snapshot-bounded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots = new FileSnapshotStore({ directory: root, maxBytes: 2_048 });
  await snapshots.write(snapshot({
    functions: {
      schema: 1,
      totalCalls: 100,
      truncated: false,
      droppedIds: 0,
      entries: Array.from({ length: 40 }, (_, index) => ({
        id: `fn-${index}`, name: `function${index}`, file: 'x.ts', line: index, kind: 'sync',
        calls: 1, totalMs: 1, maxMs: 1, asyncWallMs: 0, errors: 0,
      })),
    },
  }));
  const payload = JSON.parse(await readFile(path.join(root, 'relay-instance-1.json'), 'utf8'));
  assert.equal(payload.functions.truncated, true);
  assert.ok(payload.functions.entries.length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 2_048);
});

test('prune keeps active and fresh snapshots and removes expired ones', async (t) => {
  const now = new Date('2026-11-15T12:00:00Z');
  const { store: snapshots } = await store(t, { now: () => now, staleAfterMs: 1_000 });
  await snapshots.write(snapshot({ instanceId: 'expired', capturedAt: new Date(now.getTime() - 60_000).toISOString() }));
  await snapshots.write(snapshot({ instanceId: 'fresh', capturedAt: now.toISOString() }));
  const removed = await snapshots.prune(10_000, () => false);
  assert.equal(removed, 1);
  assert.equal((await snapshots.read('relay', 'expired')).state, 'missing');
  assert.equal((await snapshots.read('relay', 'fresh')).state, 'current');
  await snapshots.write(snapshot({ instanceId: 'kept-active', capturedAt: new Date(now.getTime() - 60_000).toISOString() }));
  assert.equal(await snapshots.prune(10_000, (item) => item.instanceId === 'kept-active'), 0);
});

test('unsafe instance identifiers are rejected before touching disk', async (t) => {
  const { store: snapshots } = await store(t);
  await assert.rejects(snapshots.write(snapshot({ instanceId: '../escape' })), /not safe/);
  await assert.rejects(snapshots.write(snapshot({ service: 'other' })), /Unknown diagnostic snapshot service/);
});
