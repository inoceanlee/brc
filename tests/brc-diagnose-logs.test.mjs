import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const shared = new URL('../packages/shared/dist/index.js', import.meta.url).href;
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
const firstEventAt = new Date(Date.now() - 60_000);
const secondEventAt = new Date();

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: root },
  });
}

async function seed(root) {
  const { SqliteDiagnosticLog, resolveDiagnosticsDbPath } = await import(shared);
  const log = new SqliteDiagnosticLog({ databasePath: resolveDiagnosticsDbPath(path.join(root, 'data'), {}) });
  await log.write({
    level: 'info', component: 'cli', source: { file: 'cli.ts', function: 'main' },
    message: 'first event', runId: 'run-a', now: firstEventAt,
  });
  await log.write({
    level: 'error', component: 'relay', source: { file: 'relay.ts', function: 'serve' },
    message: 'second event', runId: 'run-b', now: secondEventAt,
  });
  await log.flush();
  log.close();
}

test('diagnose logs queries unified SQLite events with structured filters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diagnose-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root);

  const all = run(root, 'diagnose', 'logs', '--json');
  assert.equal(all.status, 0, all.stderr);
  const rows = JSON.parse(all.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message, 'first event');

  const filtered = run(root, 'diagnose', 'logs', '--json', '--since', secondEventAt.toISOString(), '--level', 'error', '--run-id', 'run-b');
  assert.equal(filtered.status, 0, filtered.stderr);
  const selected = JSON.parse(filtered.stdout);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].message, 'second event');
  assert.equal(selected[0].level, 'error');

  const bySource = run(root, 'diagnose', 'logs', '--json', '--source', 'serve', '--limit', '1');
  assert.equal(bySource.status, 0, bySource.stderr);
  assert.equal(JSON.parse(bySource.stdout).length, 1);

  const table = run(root, 'diagnose', 'logs', '--component', 'cli');
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /first event/);
  assert.doesNotMatch(table.stdout, /second event/);
});

test('diagnose logs rejects invalid filter values as usage errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diagnose-logs-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run(root, 'diagnose', 'logs', '--level', 'trace');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /level/i);
});
