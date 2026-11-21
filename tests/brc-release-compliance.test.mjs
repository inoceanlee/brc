import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { test } from 'node:test';

const root = path.resolve('.');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('verify-only mode skips publication and tag push', async () => {
  const { releaseActions } = await import('../scripts/release-actions.mjs');
  assert.deepEqual(releaseActions({ verifyOnly: true }), { publish: false, push: false });
  assert.deepEqual(releaseActions({ dryRun: true }), { publish: false, push: false });
  assert.deepEqual(releaseActions({}), { publish: true, push: true });
});

test('verify-only help documents no publication or push', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-brc.mjs'), '--help'], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--verify-only/);
  assert.match(result.stdout, /without publishing or pushing/);
});

test('packaging rejects a missing native process binary', async () => {
  const { nativeBinaryPath, assertNativeBinary } = await import('../scripts/build-native.mjs');
  const expected = path.join(root, 'packages', 'cli', 'dist', 'native', 'win32-x64', 'brc-process.exe');
  assert.equal(nativeBinaryPath('win32', 'x64'), expected);
  assert.equal(nativeBinaryPath('linux', 'x64'), null);
  assert.throws(() => assertNativeBinary(null), /missing/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-native-check-'));
  try {
    const binary = path.join(directory, 'brc-process.exe');
    await assert.rejects(Promise.resolve().then(() => assertNativeBinary(binary)), /missing/);
    await writeFile(binary, 'binary');
    assert.doesNotThrow(() => assertNativeBinary(binary));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interrupt kills the whole process group off Windows', async () => {
  const { interruptChild } = await import('../scripts/release-runner.mjs');
  const calls = [];
  interruptChild({ pid: 4242 }, 'linux', (pid, signal) => calls.push([pid, signal]));
  assert.deepEqual(calls, [[-4242, 'SIGINT']]);
  interruptChild({ pid: 0 }, 'linux', (pid) => calls.push([pid]));
  assert.equal(calls.length, 1);
});

test('Node minimum version matches across both README files and root engines', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const minimum = /(\d+\.\d+\.\d+)/.exec(manifest.engines.node)?.[1];
  assert.ok(minimum, 'root engines must declare a minimum Node version');
  assert.match(await read('README.md'), new RegExp('Node\\.js ' + minimum.replaceAll('.', '\\.') + ' or newer'));
  assert.match(await read('README_zh.md'), new RegExp('Node\\.js ' + minimum.replaceAll('.', '\\.') + ' 或更高版本'));
});

test('CI test matrix covers Windows Linux and macOS with unit tests', async () => {
  const doc = yaml.load(await read('.github/workflows/ci.yml'));
  assert.deepEqual(doc.jobs.test.strategy.matrix.os, ['windows-latest', 'ubuntu-latest', 'macos-latest']);
  const steps = doc.jobs.test.steps;
  assert.ok(steps.some((step) => step.if === "runner.os == 'Windows'" && String(step.run).includes('pnpm test:unit')));
  assert.ok(steps.some((step) => step.run === 'pnpm test:unit' && step.if === "runner.os != 'Windows'"));
});
