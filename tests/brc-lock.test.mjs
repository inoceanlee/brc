import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LifecycleLock } from '../packages/cli/dist/adapters/storage/lock.js';
import { inspectProcess } from '../packages/cli/dist/adapters/process/identity.js';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-check-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const paths = { root, runtime: path.join(root, 'runtime') };
  await mkdir(paths.runtime);
  return paths;
}

test('lock publishes owner atomically and serializes independent instances', async (t) => {
  const paths = await sandbox(t);
  const first = new LifecycleLock(paths, { waitMs: 5000, pollMs: 20 });
  const second = new LifecycleLock(paths, { waitMs: 5000, pollMs: 20 });
  const steps = [];
  let notify;
  const entered = new Promise((done) => { notify = done; });
  const a = first.runExclusive(async () => {
    const info = await stat(path.join(paths.runtime, 'lifecycle.lock'));
    assert.ok(info.isDirectory());
    const owner = JSON.parse(await readFile(path.join(paths.runtime, 'lifecycle.lock', 'owner.json'), 'utf8'));
    assert.equal(owner.workspaceRoot, paths.root);
    assert.equal(owner.pid, process.pid);
    steps.push('a-enter');
    notify();
    await sleep(1500);
    steps.push('a-leave');
  });
  await entered;
  const b = second.runExclusive(async () => { steps.push('b-enter'); });
  await Promise.all([a, b]);
  assert.deepEqual(steps, ['a-enter', 'a-leave', 'b-enter']);
  assert.equal((await readdir(paths.runtime)).filter((x) => x === 'lifecycle.lock').length, 0);
});

test('recursive lock fails without deadlock', async (t) => {
  const paths = await sandbox(t);
  const lock = new LifecycleLock(paths);
  await lock.runExclusive(async () => {
    await assert.rejects(() => lock.runExclusive(async () => {}), /recursive/i);
  });
});

test('unpublished owner is preserved on lock contention', async (t) => {
  const paths = await sandbox(t);
  await mkdir(path.join(paths.runtime, 'lifecycle.lock'));
  await assert.rejects(() => new LifecycleLock(paths, { waitMs: 90, pollMs: 15 }).runExclusive(async () => {}));
  assert.ok((await stat(path.join(paths.runtime, 'lifecycle.lock'))).isDirectory());
});

test('reclaims a lock whose owner PID has been reused across reboots', async (t) => {
  const paths = await sandbox(t);
  const owner = await inspectProcess(process.pid);
  assert.ok(owner);
  await mkdir(path.join(paths.runtime, 'lifecycle.lock'));
  // Simulate a lock written before reboot with different createdAt/token but current PID
  await writeFile(path.join(paths.runtime, 'lifecycle.lock', 'owner.json'), JSON.stringify({
    ...owner, createdAt: '0', workspaceRoot: paths.root, token: '12345678-1234-4234-8234-123456789abc', version: 1,
  }));
  const store = new (await import('../packages/cli/dist/adapters/storage/lock-store.js')).LockStore(paths);
  // Must reclaim the stale lock because identity does not match the live process identity
  assert.equal(await store.reclaimExpired(inspectProcess), true);
  assert.equal((await readdir(paths.runtime)).filter((x) => x === 'lifecycle.lock').length, 0);
});

test('release preserves a replaced lock directory', async (t) => {
  const paths = await sandbox(t);
  const original = path.join(paths.runtime, 'lifecycle.lock');
  await assert.rejects(() => new LifecycleLock(paths).runExclusive(async () => {
    await rename(original, path.join(paths.runtime, 'owner-moved'));
    await mkdir(original);
    await writeFile(path.join(original, 'owner.json'), '{"token":"another-owner"}');
  }), /owner/i);
  assert.equal(await readFile(path.join(original, 'owner.json'), 'utf8'), '{"token":"another-owner"}');
});

test('existing lock file cannot be replaced by directory acquisition', async (t) => {
  const paths = await sandbox(t);
  const file = path.join(paths.runtime, 'lifecycle.lock');
  const contents = 'unrecognized previous owner';
  await writeFile(file, contents);
  await assert.rejects(() => new LifecycleLock(paths, { waitMs: 90, pollMs: 15 }).runExclusive(async () => {}));
  assert.equal(await readFile(file, 'utf8'), contents);
  assert.equal((await stat(file)).isFile(), true);
});

test('recovers a lock whose original process has exited', async (t) => {
  const paths = await sandbox(t);
  const prior = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(prior.status, 0);
  assert.ok(prior.pid > 0);
  const lock = path.join(paths.runtime, 'lifecycle.lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    version: 1, pid: prior.pid, createdAt: '1', executablePath: process.execPath,
    commandLine: 'exited-test-process', workspaceRoot: paths.root,
    token: '22334455-2233-4233-8233-223344556677',
  }));
  await new LifecycleLock(paths, { waitMs: 3000, pollMs: 20 }).runExclusive(async () => {
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
  });
  assert.deepEqual(await readdir(paths.runtime), []);
});

test('refuses a junction lock and preserves its target', async (t) => {
  const paths = await sandbox(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-junction-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
  const link = path.join(paths.runtime, 'lifecycle.lock');
  await symlink(outside, link, 'junction');
  await assert.rejects(() => new LifecycleLock(paths, { waitMs: 100, pollMs: 10 }).runExclusive(async () => {}));
  assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
});

test('reclaims an abandoned directory lock only after its owner exits', async (t) => {
  const { spawn } = await import('node:child_process');
  const paths = await sandbox(t);
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  const identity = await inspectProcess(child.pid);
  assert.ok(identity);
  const lock = path.join(paths.runtime, 'lifecycle.lock');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    ...identity, version: 1, workspaceRoot: paths.root,
    token: '11111111-2222-3333-4444-555555555555',
  }));
  const store = new (await import('../packages/cli/dist/adapters/storage/lock-store.js')).LockStore(paths);
  assert.equal(await store.reclaimExpired(inspectProcess), false);
  child.kill();
  await new Promise((resolve) => child.once('close', resolve));
  await new LifecycleLock(paths, { waitMs: 2000, pollMs: 20 }).runExclusive(async () => {
    assert.equal((await stat(lock)).isDirectory(), true);
  });
  await assert.rejects(() => stat(lock), { code: 'ENOENT' });
});

test('a linked data root cannot redirect lock creation outside the sandbox', async (t) => {
  const { symlink } = await import('node:fs/promises');
  const paths = await sandbox(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-external-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const link = path.join(paths.root, 'linked-root');
  await symlink(outside, link, 'junction');
  await assert.rejects(() => new LifecycleLock({
    ...paths, root: link, runtime: path.join(link, 'runtime'),
  }).runExclusive(async () => {}), /plain directory/);
  await assert.rejects(() => stat(path.join(outside, 'runtime')), { code: 'ENOENT' });
});
