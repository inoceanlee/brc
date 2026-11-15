import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: root },
  });
}

test('version is available without initializing BRC data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).version;
  for (const args of [['--version'], ['version']]) {
    const result = run(root, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
});

test('status JSON has a single parseable value and no cleanup text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-status-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(root, 'status', '--json');
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.services.length, 3);
  assert.deepEqual(parsed.services.map((item) => item.state), ['stopped', 'stopped', 'stopped']);
});

test('startup diagnosis explicitly reports missing data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diagnose-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(root, 'diagnose', 'startup', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { state: 'missing', summary: null });
});

test('failed isolated startup records a queryable stage trace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-startup-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = run(root, 'start', '--timing');
  assert.notEqual(started.status, 0);
  const queried = run(root, 'diagnose', 'startup', '--json');
  assert.equal(queried.status, 0, queried.stderr);
  const result = JSON.parse(queried.stdout);
  assert.equal(result.state, 'recorded');
  assert.equal(result.summary.command, 'start');
  assert.equal(result.summary.status, 'failed');
  assert.ok(result.summary.durationMs >= 0);
  assert.ok(result.summary.stages.some((stage) => stage.stage === 'command'));
});
