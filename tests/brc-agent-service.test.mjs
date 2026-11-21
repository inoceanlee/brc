import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));

function run(args) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-service-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawnSync(process.execPath, [cli, ...args], {
    env: { ...env, BRC_DATA_ROOT: root, CI: 'true', DO_NOT_TRACK: '1' },
    input: '', encoding: 'utf8', timeout: 6000,
  });
  rmSync(root, { recursive: true, force: true });
  return child;
}

test('service install and uninstall reject unconfirmed noninteractive changes', () => {
  for (const command of [['service', 'install'], ['service', 'uninstall']]) {
    const result = run([...command, '--no-input', '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.exit_code, 2);
    assert.equal(result.stdout, '');
  }
});

test('service preview has no side effects even with --yes', () => {
  for (const command of [['service', 'install'], ['service', 'uninstall']]) {
    const result = run([...command, '--yes', '--preview', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).changed, false);
    assert.equal(result.stderr, '');
  }
});

test('Windows task ownership requires exact Agent launcher path', async () => {
  const { ownsWindowsTask } = await import('../packages/agent/dist/adapters/service/service.js');
  const target = 'C:\\Program Files\\BRC\\start-agent.vbs';
  const xml = '<Task><Actions><Exec><Command>wscript.exe</Command><Arguments>"C:\\Program Files\\BRC\\start-agent.vbs"</Arguments></Exec></Actions></Task>';
  assert.equal(ownsWindowsTask(xml, target), true);
  assert.equal(ownsWindowsTask(xml.replace('start-agent.vbs','other-agent.vbs'), target), false);
  assert.equal(ownsWindowsTask('<Task><Command>powershell.exe</Command></Task>', target), false);
});
