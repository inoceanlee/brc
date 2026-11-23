import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const binary = path.resolve('native/brc-process/target/x86_64-pc-windows-msvc/release/brc-process.exe');
function run(...args) {
  return spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000 });
}
test('native inspector exists and returns a complete identity for current PID', { skip: process.platform !== 'win32' }, () => {
  assert.equal(existsSync(binary), true);
  const result = run('inspect', String(process.pid), String(process.pid));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.processes.length, 1);
  assert.equal(parsed.processes[0].status, 'found');
  assert.ok(/^\d+$/.test(parsed.processes[0].createdAt));
  assert.ok(parsed.processes[0].executablePath.toLowerCase().includes('node'));
  assert.ok(parsed.processes[0].commandLine.includes('brc-native.test.mjs'));
});
test('native inspector rejects malformed arguments and reports missing processes', { skip: process.platform !== 'win32' }, () => {
  assert.notEqual(run('inspect', '-1').status, 0);
  assert.notEqual(run('inspect', 'abc').status, 0);
  assert.notEqual(run('noop', '123').status, 0);
  const result = run('inspect', '4294967294');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { processes: [{ pid: 4294967294, status: 'not_found' }] });
});

test('Windows inspector fails closed when its packaged binary is missing', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const root = mkdtempSync(path.join(tmpdir(), 'brc-inspector-missing-'));
  try {
    const destination = path.join(root, 'dist', 'lifecycle', 'identity.mjs');
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.resolve('packages/cli/dist/adapters/process/identity.js'), destination);
    const { inspectProcesses } = await import(pathToFileURL(destination).href);
    if (process.platform === 'win32') {
      await assert.rejects(inspectProcesses([process.pid]), /Native Windows process inspection failed/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows inspector maps OPEN_PROCESS errors to null instead of throwing', async () => {
  if (process.platform !== 'win32') return;
  const { inspectProcesses } = await import('../packages/cli/dist/adapters/process/identity.js');
  // On Windows, PID 4 (System) always returns OPEN_PROCESS from OpenProcess for non-admin callers
  const result = await inspectProcesses([4]);
  assert.equal(result.get(4), null);
});

test('native diagnostics stay opt-in and keep the process contract', { skip: process.platform !== 'win32' }, () => {
  const plain = run('inspect', '4294967294');
  assert.deepEqual(JSON.parse(plain.stdout), { processes: [{ pid: 4294967294, status: 'not_found' }] });
  const result = spawnSync(binary, ['inspect', String(process.pid)], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000,
    env: { ...process.env, BRC_DIAGNOSTICS_ENABLED: 'true' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.processes[0].status, 'found');
  assert.ok(parsed.diagnostics, 'diagnostics appear only when enabled');
});

