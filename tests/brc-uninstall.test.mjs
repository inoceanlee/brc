import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { uninstallBrc } from '../packages/cli/dist/adapters/storage/uninstall.js';
import { identifyGlobalPackageManager, packageRemovalArguments, BRC_PACKAGE_NAME } from '../packages/cli/dist/adapters/package/global-package.js';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { LifecycleLock as LifecycleLockImpl } from '../packages/cli/dist/adapters/storage/lock.js';
import { inspectProcess, ProcessManager } from '../packages/cli/dist/adapters/process/controller.js';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { cleanRuntime as runCleanup } from '../packages/cli/dist/adapters/storage/cleanup.js';
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

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-uninstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'].map((name) => mkdir(path.join(root, name))));
  return { root, paths: paths(root) };
}

function dependencies(fixture, overrides = {}) {
  return {
    yes: true,
    paths: fixture.paths,
    confirm: async () => true,
    stopServices: async () => {},
    clean: async () => {},
    removePackage: async () => {},
    write: () => {},
    ...overrides,
  };
}

test('package removal follows the global installation owner', () => {
  const pnpmRoot = path.join(os.tmpdir(), 'pnpm-global', 'v11');
  const npmRoot = path.join(os.tmpdir(), 'npm-global', 'node_modules');
  const roots = { pnpm: pnpmRoot, npm: npmRoot };
  const pnpmPackage = path.join(pnpmRoot, 'installation', 'node_modules', '@inoceanlee', 'brc', 'dist', 'cli.js');
  const npmPackage = path.join(npmRoot, '@inoceanlee', 'brc', 'dist', 'cli.js');

  assert.equal(identifyGlobalPackageManager(pnpmPackage, roots), 'pnpm');
  assert.equal(identifyGlobalPackageManager(npmPackage, roots), 'npm');
  assert.equal(identifyGlobalPackageManager(path.join(os.tmpdir(), 'source', 'brc', 'cli.js'), roots), undefined);
  assert.equal(identifyGlobalPackageManager(pnpmPackage, { pnpm: pnpmRoot, npm: pnpmRoot }), undefined);
  assert.deepEqual(packageRemovalArguments('pnpm'), ['remove', '--global', BRC_PACKAGE_NAME]);
  assert.deepEqual(packageRemovalArguments('npm'), ['uninstall', '--global', BRC_PACKAGE_NAME]);
});

test('package manager preflight failure keeps services and private data intact', async (t) => {
  const fixtureRoot = await fixture(t);
  const marker = path.join(fixtureRoot.paths.data, 'keep.txt');
  await writeFile(marker, 'private data');
  const calls = [];

  await assert.rejects(uninstallBrc(dependencies(fixtureRoot, {
    preparePackageRemoval: () => { calls.push('preflight'); throw new Error('unknown package manager'); },
    stopServices: async () => calls.push('stop'),
    clean: async () => calls.push('clean'),
    removePackage: async () => calls.push('remove'),
  })), /unknown package manager/);

  assert.deepEqual(calls, ['preflight']);
  assert.equal(await readFile(marker, 'utf8'), 'private data');
});

test('cancelled uninstall leaves services, package, and private data untouched', async (t) => {
  const fixtureRoot = await fixture(t);
  const marker = path.join(fixtureRoot.root, 'data', 'keep.txt');
  await writeFile(marker, 'private data');
  const calls = [];
  const messages = [];

  await uninstallBrc(dependencies(fixtureRoot, {
    yes: false,
    confirm: async () => { calls.push('confirm'); return false; },
    stopServices: async () => calls.push('stop'),
    clean: async () => calls.push('clean'),
    removePackage: async () => calls.push('remove package'),
    write: (message) => messages.push(message),
  }));

  assert.deepEqual(calls, ['confirm']);
  assert.equal(await readFile(marker, 'utf8'), 'private data');
  assert.match(messages.join('\n'), /cancel/i);
});

test('confirmed uninstall stops, cleans, removes only BRC data, then removes package', async (t) => {
  const fixtureRoot = await fixture(t);
  const marker = path.join(fixtureRoot.root, 'data', 'private.sqlite');
  await writeFile(marker, 'isolated database');
  const calls = [];

  await uninstallBrc(dependencies(fixtureRoot, {
    confirm: async () => { calls.push('unexpected confirmation'); return false; },
    stopServices: async () => calls.push('stop'),
    clean: async () => {
      calls.push('clean');
      assert.equal(existsSync(marker), true);
    },
    removePackage: async () => {
      calls.push('remove package');
      await assert.rejects(lstat(fixtureRoot.root), { code: 'ENOENT' });
    },
  }));

  assert.deepEqual(calls, ['stop', 'clean', 'remove package']);
  assert.equal(existsSync(fixtureRoot.root), false);
});
test('uninstall cleans a stale service record before removing data', async (t) => {
  const fixtureRoot = await fixture(t);
  const services = createDefaultServices(fixtureRoot.paths, DEFAULT_SETTINGS, {});
  const relay = services.find((service) => service.name === 'relay');
  assert.ok(relay);
  const stalePid = process.pid + 1_000_000;
  assert.equal(await inspectProcess(stalePid), null);
  const recordPath = path.join(fixtureRoot.paths.runtime, 'relay.json');
  await writeFile(recordPath, JSON.stringify({
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    service: 'relay',
    pid: stalePid,
    createdAt: new Date(0).toISOString(),
    executablePath: process.execPath,
    commandLine: 'stale relay process',
    workspaceRoot: relay.workspaceRoot,
    entrypoint: relay.entrypoint,
    controlPort: DEFAULT_SETTINGS.services.relayPort,
    controlToken: 'a'.repeat(64),
  }));
  const processManager = new ProcessManager(fixtureRoot.paths);
  const serviceManager = new ServiceManager(
    fixtureRoot.paths,
    services,
    processManager,
    processManager,
    new LifecycleLock(fixtureRoot.paths),
  );

  await uninstallBrc(dependencies(fixtureRoot, {
    stopServices: () => serviceManager.stop(),
    clean: async () => { await cleanRuntime(fixtureRoot.paths, { settings: DEFAULT_SETTINGS }); },
  }));

  assert.equal(existsSync(recordPath), false);
  assert.equal(existsSync(fixtureRoot.root), false);
});

test('uninstall preserves a linked data directory and reports its path', async (t) => {
  const fixtureRoot = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-uninstall-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const marker = path.join(outside, 'keep.txt');
  await writeFile(marker, 'outside data');
  const linkedData = fixtureRoot.paths.data;
  await rm(linkedData, { recursive: true, force: true });
  await symlink(outside, linkedData, process.platform === 'win32' ? 'junction' : 'dir');
  const messages = [];
  let removedPackage = false;

  await uninstallBrc(dependencies(fixtureRoot, {
    removePackage: async () => { removedPackage = true; },
    write: (message) => messages.push(message),
  }));

  assert.equal(removedPackage, true);
  assert.equal(await readFile(marker, 'utf8'), 'outside data');
  assert.equal(existsSync(fixtureRoot.root), true);
  assert.match(messages.join('\n'), new RegExp(linkedData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('unsafe user-home data root is rejected before stopping services', async () => {
  const protectedPaths = paths(os.homedir());
  let stopped = false;
  await assert.rejects(uninstallBrc(dependencies({ paths: protectedPaths }, {
    stopServices: async () => { stopped = true; },
  })), /protected|unsafe|home/i);
  assert.equal(stopped, false);
});
test('service-stop failure leaves data and package untouched', async (t) => {
  const fixtureRoot = await fixture(t);
  const marker = path.join(fixtureRoot.root, 'data', 'keep.txt');
  await writeFile(marker, 'private data');
  const calls = [];

  await assert.rejects(uninstallBrc(dependencies(fixtureRoot, {
    stopServices: async () => { calls.push('stop'); throw new Error('service stop failed'); },
    clean: async () => calls.push('clean'),
    removePackage: async () => calls.push('remove package'),
  })), /service stop failed/);

  assert.deepEqual(calls, ['stop']);
  assert.equal(await readFile(marker, 'utf8'), 'private data');
});

test('cleanup failure skips package removal', async (t) => {
  const fixtureRoot = await fixture(t);
  const calls = [];

  await assert.rejects(uninstallBrc(dependencies(fixtureRoot, {
    stopServices: async () => calls.push('stop'),
    clean: async () => { calls.push('clean'); throw new Error('cleanup failed'); },
    removePackage: async () => calls.push('remove package'),
  })), /cleanup failed/);

  assert.deepEqual(calls, ['stop', 'clean']);
});

test('unknown root entries remain and appear in residual report', async (t) => {
  const fixtureRoot = await fixture(t);
  const foreignFile = path.join(fixtureRoot.root, 'foreign.txt');
  await writeFile(foreignFile, 'not BRC data');
  const messages = [];
  let removedPackage = false;

  await uninstallBrc(dependencies(fixtureRoot, {
    removePackage: async () => { removedPackage = true; },
    write: (message) => messages.push(message),
  }));

  assert.equal(removedPackage, true);
  assert.equal(await readFile(foreignFile, 'utf8'), 'not BRC data');
  assert.match(messages.join('\n'), new RegExp(foreignFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('linked data root is rejected before services stop', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-uninstall-outside-'));
  const linkedRoot = path.join(os.tmpdir(), `brc-uninstall-root-${process.pid}-${Date.now()}`);
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
    await rm(linkedRoot, { recursive: true, force: true });
  });
  const marker = path.join(outside, 'keep.txt');
  await writeFile(marker, 'outside data');
  await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  let stopped = false;

  await assert.rejects(uninstallBrc(dependencies({ paths: paths(linkedRoot) }, {
    stopServices: async () => { stopped = true; },
  })), /link|junction|plain directory/i);

  assert.equal(stopped, false);
  assert.equal(await readFile(marker, 'utf8'), 'outside data');
});
test('uninstall preserves and reports a file locked by another process', { skip: process.platform !== 'win32' }, async (t) => {
  const fixtureRoot = await fixture(t);
  const lockedFile = path.join(fixtureRoot.paths.data, 'locked.sqlite');
  const scriptRoot = await mkdtemp(path.join(os.tmpdir(), 'brc-uninstall-lock-'));
  const scriptPath = path.join(scriptRoot, 'hold-file.ps1');
  const releasePath = path.join(scriptRoot, 'release');
  await writeFile(lockedFile, 'isolated database');
  await writeFile(scriptPath, [
    "$ErrorActionPreference = 'Stop'",
    '$stream = [System.IO.File]::Open($env:BRC_TEST_LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    "[Console]::Out.WriteLine('LOCKED')",
    '[Console]::Out.Flush()',
    'while (-not (Test-Path -LiteralPath $env:BRC_TEST_RELEASE_LOCK)) { Start-Sleep -Milliseconds 25 }',
    '$stream.Dispose()',
  ].join('\r\n'));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    cwd: os.tmpdir(),
    env: { ...process.env, BRC_TEST_LOCK_TARGET: lockedFile, BRC_TEST_RELEASE_LOCK: releasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`PowerShell lock process exited with ${code}: ${stderr}`));
    });
  });
  t.after(async () => {
    await writeFile(releasePath, '').catch(() => {});
    await exited.catch(() => {});
    await rm(scriptRoot, { recursive: true, force: true });
  });
  await ready;

  const messages = [];
  let removedPackage = false;
  try {
    await uninstallBrc(dependencies(fixtureRoot, {
      removePackage: async () => { removedPackage = true; },
      write: (message) => messages.push(message),
    }));
  } finally {
    await writeFile(releasePath, '');
  }
  const exitCode = await exited;
  assert.equal(exitCode, 0, stderr);
  assert.equal(removedPackage, true);
  assert.equal(await readFile(lockedFile, 'utf8'), 'isolated database');
  assert.match(messages.join('\n'), new RegExp(lockedFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
