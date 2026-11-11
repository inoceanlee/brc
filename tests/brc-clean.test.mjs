import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { cleanRuntime } from '../packages/cli/dist/maintenance/cleanup.js';
import { ProcessManager } from '../packages/cli/dist/lifecycle/processes.js';
import { LifecycleLock } from '../packages/cli/dist/lifecycle/lock.js';
import { inspectProcess } from '../packages/cli/dist/lifecycle/identity.js';
import { appendRotatingLog } from '../packages/shared/dist/managed-log.js';

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const fakeService = `
import { createServer } from 'node:http';
import { renameSync, writeFileSync } from 'node:fs';
const token = process.env.BRC_CONTROL_TOKEN;
const readyFile = process.env.BRC_CONTROL_READY_FILE;
const id = process.env.BRC_MANAGED_ID;
const service = process.env.BRC_MANAGED_SERVICE;
const server = createServer((req, res) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== 'Bearer ' + token) return res.writeHead(404).end();
  if (req.method === 'GET' && req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, state: 'running', detail: 'ready' }));
  if (req.method === 'POST' && req.url === '/shutdown') { res.writeHead(202).end(); setTimeout(() => process.exit(0), 20); return; }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const temporary = readyFile + '.tmp';
writeFileSync(temporary, JSON.stringify({ id, service, pid: process.pid, port: address.port }));
renameSync(temporary, readyFile);
`;

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

async function makeRoot(t, registerCleanup = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-clean-'));
  const brcPaths = paths(root);
  await Promise.all(Object.values(brcPaths).filter((item) => item !== root).map((item) => mkdir(item, { recursive: true })));
  if (registerCleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths: brcPaths };
}

async function makeManagedRelay(t) {
  const harness = await makeRoot(t, false);
  const entrypoint = path.join(harness.root, 'fake-service.mjs');
  await writeFile(entrypoint, fakeService);
  const spec = { name: 'relay', entrypoint, workspaceRoot: harness.root, cwd: harness.root, env: {} };
  const manager = new ProcessManager(harness.paths, { startupTimeoutMs: 3000, shutdownTimeoutMs: 300, pollIntervalMs: 25 });
  t.after(async () => {
    await manager.stop(spec);
    await rm(harness.root, { recursive: true, force: true });
  });
  return { ...harness, entrypoint, spec, manager };
}


async function exists(filename) {
  try { await stat(filename); return true; } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function setAge(filename, ageMs) {
  const date = new Date(Date.now() - ageMs);
  await utimes(filename, date, date);
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += await directoryBytes(filename);
    else if (entry.isFile()) bytes += (await stat(filename)).size;
  }
  return bytes;
}

test('cleanup bypasses the lifecycle lock when only fresh logs and active versions exist', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const currentVersion = path.join(brcPaths.traefik, 'versions', '3.7.16');
  await mkdir(currentVersion, { recursive: true });
  await writeFile(path.join(currentVersion, 'traefik.exe'), 'current version');
  await writeFile(path.join(brcPaths.traefik, 'versions.json'), JSON.stringify({
    version: 1, current: '3.7.16', previous: null,
  }));
  const freshLog = path.join(brcPaths.logs, 'relay.log');
  await writeFile(freshLog, 'recent log');
  const original = LifecycleLock.prototype.runExclusive;
  let lockCalls = 0;
  LifecycleLock.prototype.runExclusive = async function (...args) {
    lockCalls++;
    return original.apply(this, args);
  };
  let report;
  try { report = await cleanRuntime(brcPaths); }
  finally { LifecycleLock.prototype.runExclusive = original; }
  assert.equal(lockCalls, 0);
  assert.equal(report.removed, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(await exists(freshLog), true);
  assert.equal(await exists(currentVersion), true);
});

test('cleans expired logs when the runtime directory does not exist', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  await rm(brcPaths.runtime, { recursive: true });
  const filename = path.join(brcPaths.logs, 'expired.log');
  await writeFile(filename, 'expired');
  await setAge(filename, 8 * DAY);

  const report = await cleanRuntime(brcPaths);

  assert.equal(await exists(filename), false);
  assert.equal(report.failures.length, 0);
});

test('dry-run reports a missing runtime without creating it', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  await rm(brcPaths.runtime, { recursive: true });
  const filename = path.join(brcPaths.logs, 'expired.log');
  await writeFile(filename, 'expired');
  await setAge(filename, 8 * DAY);

  const report = await cleanRuntime(brcPaths, { dryRun: true });

  assert.equal(await exists(brcPaths.runtime), false);
  assert.equal(await exists(filename), true);
  assert.ok(report.preserved.some((item) => item.path === brcPaths.runtime && /not evaluated/i.test(item.reason)));
});

test('removes expired logs and downloads while preserving recent files, SQLite, and credentials', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const oldLog = path.join(brcPaths.logs, 'expired.log');
  const recentLog = path.join(brcPaths.logs, 'recent.log');
  const oldDownload = path.join(brcPaths.tmp, 'traefik.zip.part');
  const recentDownload = path.join(brcPaths.tmp, 'active-download.part');
  const databaseFiles = ['relay.sqlite', 'relay.sqlite-wal', 'relay.sqlite-shm'].map((name) => path.join(brcPaths.data, name));
  const credential = path.join(brcPaths.config, 'agent-credentials.json');
  await Promise.all([oldLog, recentLog, oldDownload, recentDownload, ...databaseFiles, credential].map((file) => writeFile(file, 'keep or remove by policy')));
  await Promise.all([oldLog, oldDownload, ...databaseFiles, credential].map((file) => setAge(file, 8 * DAY)));

  const report = await cleanRuntime(brcPaths);

  assert.equal(await exists(oldLog), false);
  assert.equal(await exists(oldDownload), false);
  assert.equal(await exists(recentLog), true);
  assert.equal(await exists(recentDownload), true);
  for (const file of [...databaseFiles, credential]) assert.equal(await exists(file), true);
  assert.ok(report.removed >= 2);
  assert.equal(report.failures.length, 0);
});

test('keeps active service log and trims total logs to 50 MiB', async (t) => {
  const harness = await makeManagedRelay(t);
  await harness.manager.start(harness.spec);
  const activeLog = path.join(harness.paths.logs, 'relay.log');
  const oldest = path.join(harness.paths.logs, 'oldest.log');
  const newer = path.join(harness.paths.logs, 'newer.log');
  await writeFile(activeLog, Buffer.alloc(MIB, 0x61));
  await writeFile(oldest, Buffer.alloc(25 * MIB, 0x62));
  await writeFile(newer, Buffer.alloc(25 * MIB, 0x63));
  await setAge(oldest, 3 * DAY);
  await setAge(newer, 2 * DAY);
  await setAge(activeLog, 8 * DAY);

  const report = await cleanRuntime(harness.paths);

  assert.equal(await exists(activeLog), true);
  assert.equal(await exists(oldest), false);
  assert.ok(await exists(newer));
  assert.ok(await directoryBytes(harness.paths.logs) <= 50 * MIB);
  assert.ok(report.removed >= 1);
});

test('preserves PID-reused and corrupt records without stopping either process', async (t) => {
  const harness = await makeManagedRelay(t);
  await harness.manager.start(harness.spec);
  const recordPath = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(recordPath, 'utf8');
  const reused = { ...JSON.parse(original), createdAt: 'different-process-start-time' };
  await writeFile(recordPath, JSON.stringify(reused));
  const corruptPath = path.join(harness.paths.runtime, 'agent.json');
  await writeFile(corruptPath, '{broken');

  const report = await cleanRuntime(harness.paths);

  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), reused);
  assert.equal(await readFile(corruptPath, 'utf8'), '{broken');
  assert.ok(report.preserved.some((item) => item.path === recordPath));
  assert.ok(report.preserved.some((item) => item.path === corruptPath));
  await writeFile(recordPath, original);
  await harness.manager.stop(harness.spec);
});

test('removes a valid process record only after its process exits', async (t) => {
  const harness = await makeManagedRelay(t);
  await harness.manager.start(harness.spec);
  const status = await harness.manager.status(harness.spec);
  assert.ok(status.pid);
  process.kill(status.pid);
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await harness.manager.status(harness.spec)).state === 'stopped') break;
    await sleep(100);
  }

  await cleanRuntime(harness.paths);

  assert.equal(await exists(path.join(harness.paths.runtime, 'relay.json')), false);
});

test('preserves an exited service record whose entrypoint is outside its workspace', async (t) => {
  const harness = await makeManagedRelay(t);
  await harness.manager.start(harness.spec);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const original = await readFile(filename, 'utf8');
  const record = JSON.parse(original);
  process.kill(record.pid);
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await harness.manager.status(harness.spec)).state === 'stopped') break;
    await sleep(100);
  }
  record.entrypoint = path.join(path.dirname(harness.root), 'outside-service.js');
  await writeFile(filename, JSON.stringify(record));
  const report = await cleanRuntime(harness.paths);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).entrypoint, record.entrypoint);
  assert.ok(report.preserved.some((item) => item.path === filename && /workspace/i.test(item.reason)));
  await writeFile(filename, original);
});

test('pairing agent is active without a cleanup warning', async (t) => {
  const harness = await makeRoot(t, false);
  const entrypoint = path.join(harness.root, 'pairing-service.mjs');
  await writeFile(entrypoint, fakeService.replace("state: 'running'", "state: 'pairing'"));
  const spec = { name: 'agent', entrypoint, workspaceRoot: harness.root, cwd: harness.root, env: {} };
  const manager = new ProcessManager(harness.paths, { startupTimeoutMs: 3000, shutdownTimeoutMs: 300, pollIntervalMs: 25 });
  t.after(async () => {
    await manager.stop(spec);
    await rm(harness.root, { recursive: true, force: true });
  });
  await manager.start(spec);
  const report = await cleanRuntime(harness.paths);
  const filename = path.join(harness.paths.runtime, 'agent.json');
  assert.equal(await exists(filename), true);
  assert.equal(report.preserved.some((item) => item.path === filename), false);
});


test('preserves live and malformed ready and lock records', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const ready = path.join(brcPaths.runtime, 'relay.live.ready.json');
  const malformed = path.join(brcPaths.runtime, 'agent.bad.ready.json');
  const lock = path.join(brcPaths.runtime, 'lifecycle.lock');
  await writeFile(ready, JSON.stringify({ pid: process.pid }));
  await writeFile(malformed, '{broken');
  const identity = await inspectProcess(process.pid);
  assert.ok(identity);
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    version: 1, ...identity, workspaceRoot: brcPaths.root, token: '76543210-4321-4321-4321-123456789abc',
  }));

  const report = await cleanRuntime(brcPaths);

  for (const filename of [ready, malformed, lock]) assert.equal(await exists(filename), true, filename);
  assert.ok(report.preserved.some((item) => item.path === lock));
  assert.ok(report.preserved.some((item) => item.path === brcPaths.runtime));
});

test('cleanup skips service logs and versions while lifecycle changes hold the lock', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const log = path.join(brcPaths.logs, 'relay.log');
  const versions = path.join(brcPaths.traefik, 'versions');
  const version = path.join(versions, 'next');
  const manifest = path.join(brcPaths.traefik, 'versions.json');
  await mkdir(version, { recursive: true });
  await writeFile(path.join(version, 'traefik.exe'), 'version');
  await writeFile(log, 'startup output');
  await setAge(log, 8 * DAY);
  await setAge(version, 8 * DAY);
  await writeFile(manifest, JSON.stringify({ version: 1, current: 'old', previous: null }));

  let entered;
  let release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const operation = new LifecycleLock(brcPaths).runExclusive(async () => {
    entered();
    await hold;
    await writeFile(manifest, JSON.stringify({ version: 1, current: 'next', previous: 'old' }));
  });
  await inside;
  try {
    const report = await cleanRuntime(brcPaths);
    assert.equal(await exists(log), true);
    assert.equal(await exists(version), true);
    assert.ok(report.preserved.some((item) => item.path === brcPaths.runtime && /lock/i.test(item.reason)));
  } finally {
    release();
    await operation;
  }
  await cleanRuntime(brcPaths);
  assert.equal(await exists(version), true);
});

test('removes ready and lock records for an exited process', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const ready = path.join(brcPaths.runtime, 'relay.exited.ready.json');
  const lock = path.join(brcPaths.runtime, 'lifecycle.lock');
  await writeFile(ready, JSON.stringify({ pid: child.pid }));
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    version: 1, pid: child.pid, createdAt: 'old', executablePath: process.execPath,
    commandLine: 'old', workspaceRoot: brcPaths.root, token: '76543210-4321-4321-4321-123456789abc',
  }));

  await cleanRuntime(brcPaths);

  assert.equal(await exists(ready), false);
  assert.equal(await exists(lock), false);
});

test('does not follow a directory junction outside the data root', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-clean-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'expired.log');
  const junction = path.join(brcPaths.logs, 'external');
  await writeFile(sentinel, 'do not traverse');
  await setAge(sentinel, 8 * DAY);
  await symlink(outside, junction, 'junction');

  const report = await cleanRuntime(brcPaths);

  assert.equal(await readFile(sentinel, 'utf8'), 'do not traverse');
  assert.ok(report.preserved.some((item) => item.path === junction));
});

test('retains current and rollback Traefik versions and prunes expired extras', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const versions = path.join(brcPaths.traefik, 'versions');
  const current = path.join(versions, '3.7.16');
  const rollback = path.join(versions, '3.7.15');
  const expired = path.join(versions, '3.6.0');
  await Promise.all([current, rollback, expired].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all([current, rollback, expired].map((directory) => writeFile(path.join(directory, 'traefik.exe'), 'version')));
  await writeFile(path.join(brcPaths.traefik, 'versions.json'), JSON.stringify({ version: 1, current: '3.7.16', previous: '3.7.15' }));
  await setAge(expired, 8 * DAY);
  await setAge(current, 8 * DAY);
  await setAge(rollback, 8 * DAY);

  await cleanRuntime(brcPaths);

  assert.equal(await exists(current), true);
  assert.equal(await exists(rollback), true);
  assert.equal(await exists(expired), false);
});

test('dry-run reports cleanup candidates without deleting them', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const oldLog = path.join(brcPaths.logs, 'expired.log');
  await writeFile(oldLog, 'old');
  await setAge(oldLog, 8 * DAY);

  const report = await cleanRuntime(brcPaths, { dryRun: true });

  assert.equal(await exists(oldLog), true);
  assert.equal(report.removed, 0);
  assert.ok(report.wouldRemove >= 1);
});

test('rotates repeated service output to a bounded active file and one backup', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const logFile = path.join(brcPaths.logs, 'relay.log');
  for (let i = 0; i < 20; i++) await appendRotatingLog(logFile, `${String(i).padStart(2, '0')}:${'x'.repeat(48)}\n`, 64);

  assert.ok((await stat(logFile)).size <= 64);
  assert.ok((await stat(`${logFile}.1`)).size <= 64);
  assert.equal((await readdir(brcPaths.logs)).length, 2);
});

test('managed console captures stdout and stderr in its rotating log', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const logFile = path.join(brcPaths.logs, 'relay.log');
  const moduleUrl = JSON.stringify(new URL('../packages/shared/dist/managed-log.js', import.meta.url).href);
  const source = `import { installManagedLog } from ${moduleUrl};\nconst log = installManagedLog({ maxBytes: 256 });\nconsole.log('relay standard output');\nconsole.error('relay standard error');\nawait log?.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRC_LOG_FILE: logFile },
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = await readFile(logFile, 'utf8');
  assert.match(contents, /relay standard output/);
  assert.match(contents, /relay standard error/);
});

test('Agent activity logs stay bounded during continuous writes', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const trackToolsUrl = JSON.stringify(new URL('../packages/agent/dist/core/utils/trackTools.js', import.meta.url).href);
  const fuzzyLoggerUrl = JSON.stringify(new URL('../packages/agent/dist/core/utils/fuzzySearchLogger.js', import.meta.url).href);
  const source = `
import { trackToolCall } from ${trackToolsUrl};
import { fuzzySearchLogger } from ${fuzzyLoggerUrl};
const payload = 'x'.repeat(1024 * 1024);
for (let i = 0; i < 4; i++) await trackToolCall('test', { payload });
const entry = {
  timestamp: new Date(), searchText: payload, foundText: 'found', similarity: 1, executionTime: 1,
  exactMatchCount: 1, expectedReplacements: 1, fuzzyThreshold: 0.9, belowThreshold: false,
  diff: payload, searchLength: payload.length, foundLength: 5, fileExtension: 'ts',
  characterCodes: 'x', uniqueCharacterCount: 1, diffLength: payload.length,
};
for (let i = 0; i < 3; i++) await fuzzySearchLogger.log(entry);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRC_HOME: brcPaths.config },
  });

  assert.equal(result.status, 0, result.stderr);
  const logs = [
    path.join(brcPaths.config, 'claude_tool_call.log'),
    path.join(brcPaths.config, 'claude_tool_call.log.1'),
    path.join(brcPaths.config, 'logs', 'fuzzy-search.log'),
    path.join(brcPaths.config, 'logs', 'fuzzy-search.log.1'),
  ];
  let total = 0;
  for (const filename of logs) {
    const size = (await stat(filename)).size;
    assert.ok(size <= 4 * MIB, `${filename} exceeded the per-file limit`);
    total += size;
  }
  assert.ok(total <= 16 * MIB);
});

test('cleanup removes exited ready records while preserving live PIDs in the same batch', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(exited.status, 0);
  const deadFile = path.join(brcPaths.runtime, 'relay.dead.ready.json');
  const liveFile = path.join(brcPaths.runtime, 'agent.live.ready.json');
  await writeFile(deadFile, JSON.stringify({ pid: exited.pid }));
  await writeFile(liveFile, JSON.stringify({ pid: process.pid }));
  const report = await cleanRuntime(brcPaths);
  assert.equal(await exists(deadFile), false);
  assert.equal(await exists(liveFile), true);
  assert.ok(report.preserved.some((item) => item.path === liveFile));
});

test('cleanup evicts stale ready records from previous boot without inspecting process', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const staleReadyFile = path.join(brcPaths.runtime, 'agent.stale-boot.ready.json');
  await writeFile(staleReadyFile, JSON.stringify({ pid: process.pid, port: 54321 }));
  const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await utimes(staleReadyFile, past, past);
  const report = await cleanRuntime(brcPaths);
  assert.equal(await exists(staleReadyFile), false);
  assert.equal(report.preserved.some((item) => item.path === staleReadyFile), false);
});
