import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ManagedProcessResourceSampler } from '../packages/cli/dist/adapters/process/resources.js';
import { inspectProcess } from '../packages/cli/dist/adapters/process/identity.js';
import { readResourceDiagnostics } from '../packages/cli/dist/commands/diagnostics.js';
import { FileSnapshotStore } from '../packages/shared/dist/index.js';

test('Traefik binary sampler writes bounded snapshots and marks the final sample exited', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-resource-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = {
    pid: process.pid,
    createdAt: '123456789',
    executablePath: process.execPath,
    commandLine: process.argv.join(' '),
  };
  const snapshots = [];
  let count = 0;
  const sampler = new ManagedProcessResourceSampler({
    identity,
    instanceId: 'instance-binary',
    runtimeDirectory: path.join(root, 'runtime'),
    intervalMs: 100,
    snapshots: { write: async (snapshot) => snapshots.push(snapshot) },
    sample: async () => {
      count += 1;
      return {
        cpuUserMs: count * 25,
        cpuSystemMs: count * 5,
        cpuPercent: null,
        rssBytes: 1024 * count,
        systemPeakBytes: null,
      };
    },
  });
  await sampler.start();
  await sleep(130);
  await sampler.stop();
  assert.ok(snapshots.length >= 2);
  assert.equal(snapshots[0].service, 'traefik');
  assert.equal(snapshots[0].instanceId, 'instance-binary');
  assert.equal(snapshots[0].status, 'running');
  assert.equal(snapshots.at(-1).status, 'exited');
  assert.equal(snapshots.at(-1).resources.peak.source, 'sampled');
  await assert.rejects(readFile(path.join(root, 'runtime', 'traefik-child.json')));
});

test('resource diagnostics distinguish the Traefik binary from its Node wrapper', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-binary-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const diagnostics = path.join(root, 'diagnostics');
  await mkdir(runtime, { recursive: true });
  const identity = await inspectProcess(process.pid);
  assert.ok(identity);
  const instanceId = 'instance-binary';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(
    path.join(runtime, 'traefik-child.json'),
    JSON.stringify({ schema: 1, instanceId, ...identity }),
  ));
  const store = new FileSnapshotStore({ directory: diagnostics });
  await store.write({
    schema: 1,
    service: 'traefik',
    instanceId,
    pid: process.pid,
    capturedAt: new Date().toISOString(),
    status: 'running',
    functions: { schema: 1, totalCalls: 0, entries: [], truncated: false, droppedIds: 0 },
    resources: {
      schema: 1,
      capturedAt: new Date().toISOString(),
      source: 'platform',
      windowMs: 1000,
      cpuUserMs: 120,
      cpuSystemMs: 40,
      cpuPercent: 16,
      rssBytes: 1024 * 1024,
      heapUsedBytes: null,
      peak: { source: 'sampled', rssBytes: 2 * 1024 * 1024, windowMs: 1000 },
    },
  });
  const rows = await readResourceDiagnostics({
    root, runtime, diagnostics,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].service, 'traefik-binary');
  assert.equal(rows[0].state, 'current');
  assert.equal(rows[0].rssBytes, 1024 * 1024);
});

test('Windows binary sampler reads OS CPU and working-set counters', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-resource-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await inspectProcess(process.pid);
  assert.ok(identity);
  const snapshots = [];
  const sampler = new ManagedProcessResourceSampler({
    identity,
    instanceId: 'windows-binary',
    runtimeDirectory: path.join(root, 'runtime'),
    intervalMs: 1000,
    snapshots: { write: async (snapshot) => snapshots.push(snapshot) },
  });
  await sampler.start();
  await sampler.stop();
  assert.ok(snapshots[0].resources.rssBytes > 0);
  assert.equal(snapshots[0].resources.unavailable, undefined);
  assert.equal(snapshots.at(-1).status, 'exited');
});

test('unavailable process samples stay diagnostic and retain no fabricated CPU values', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-resource-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await inspectProcess(process.pid);
  assert.ok(identity);
  const snapshots = [];
  const sampler = new ManagedProcessResourceSampler({
    identity, instanceId: 'unavailable-binary',
    runtimeDirectory: path.join(root, 'runtime'),
    intervalMs: 1000,
    snapshots: { write: async (snapshot) => snapshots.push(snapshot) },
    sample: async () => { throw new Error('process denied'); },
  });
  await sampler.start();
  await sampler.stop();
  assert.match(snapshots[0].resources.unavailable, /process denied/);
  assert.equal(snapshots[0].resources.cpuPercent, null);
});

test('snapshot write failure removes the transient Traefik binary record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-resource-write-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await inspectProcess(process.pid);
  assert.ok(identity);
  const sampler = new ManagedProcessResourceSampler({
    identity, instanceId: 'write-error-binary',
    runtimeDirectory: path.join(root, 'runtime'),
    intervalMs: 1000,
    snapshots: { write: async () => { throw new Error('storage failed'); } },
    sample: async () => ({ cpuUserMs: 1, cpuSystemMs: 1, cpuPercent: null, rssBytes: 1024, systemPeakBytes: null }),
  });
  await assert.rejects(sampler.start(), /storage failed/);
  await assert.rejects(readFile(path.join(root, 'runtime', 'traefik-child.json')), { code: 'ENOENT' });
});
