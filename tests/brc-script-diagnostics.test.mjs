import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve('.');
const entry = path.join(root, 'scripts', 'script-diagnostics.mjs');
const script = path.join(root, 'scripts', 'build-native.mjs');

test('production JavaScript scripts report instrumented calls and resource snapshots', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-script-diag-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [entry, script], {
    cwd: root,
    env: { ...process.env, BRC_DIAGNOSTICS_ENABLED: 'true', BRC_DIAGNOSTICS_DIR: directory },
    timeout: 60_000,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(directory);
  const manifest = files.find((file) => /^coverage-[0-9a-f]{16}\.json$/.test(file));
  const snapshot = files.find((file) => file.startsWith('cli-script-') && file.endsWith('.json'));
  assert.ok(manifest, 'script instrumentation coverage must be recorded');
  assert.ok(snapshot, 'script process resource snapshot must be recorded');
  const coverage = JSON.parse(await readFile(path.join(directory, manifest), 'utf8'));
  assert.equal(coverage.entrypoint.replaceAll('\\', '/'), 'scripts/build-native.mjs');
  assert.ok(coverage.modules.some(([, report]) => report.instrumented > 0));
  const diagnosis = JSON.parse(await readFile(path.join(directory, snapshot), 'utf8'));
  assert.equal(diagnosis.status, 'exited');
  assert.ok(diagnosis.functions.entries.some((row) => row.name === 'buildNative' && row.calls > 0));
  assert.ok(diagnosis.resources.rssBytes > 0);
});

test('disabled script diagnostics ignores inactive sampling configuration', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-script-disabled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(root, 'scripts', 'release-config.mjs');
  const result = spawnSync(process.execPath, [entry, target], {
    cwd: directory,
    env: { ...process.env, BRC_DIAGNOSTICS_ENABLED: 'false', BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS: 'invalid', BRC_DIAGNOSTICS_DIR: directory },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(directory), []);
});

test('empty script diagnostics directory uses the temporary directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-script-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(root, 'scripts', 'release-config.mjs');
  const result = spawnSync(process.execPath, [entry, target], {
    cwd: directory,
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory, BRC_DIAGNOSTICS_ENABLED: 'true', BRC_DIAGNOSTICS_DIR: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = await readdir(directory);
  assert.deepEqual(entries, ['brc-script-diagnostics']);
  const snapshots = await readdir(path.join(directory, 'brc-script-diagnostics'));
  assert.ok(snapshots.some((name) => name.startsWith('cli-script-')));
});
