import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('importing Agent adapters does not instantiate services or create user data', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-inert-import-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const url = new URL('../packages/agent/dist/adapters/mcp/dispatcher.js', import.meta.url).href;
  const script = `
    await import(${JSON.stringify(url)});
    const { configManager } = await import(${JSON.stringify(new URL('../packages/agent/dist/adapters/storage/config-manager.js', import.meta.url).href)});
    const { toolHistory } = await import(${JSON.stringify(new URL('../packages/agent/dist/adapters/telemetry/toolHistory.js', import.meta.url).href)});
    if (configManager !== undefined || toolHistory !== undefined) process.exitCode = 7;
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 6000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.deepEqual(readdirSync(root), []);
});

test('offline help does not initialize data root or background sockets', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-help-inert-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const binary = new URL('../packages/agent/dist/cli.js', import.meta.url);
  const child = spawnSync(process.execPath, [fileURLToPath(binary), 'help'], {
    env: { ...process.env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
    encoding: 'utf8', timeout: 6000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /BRC device Agent/);
  assert.deepEqual(readdirSync(root), []);
});
