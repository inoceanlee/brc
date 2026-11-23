import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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




