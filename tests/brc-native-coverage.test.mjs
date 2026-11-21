import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

test('native function coverage is returned inside diagnostic JSON', () => {
  if (process.platform !== 'win32') return;
  const executable = path.join('packages', 'cli', 'dist', 'native', 'win32-x64', 'brc-process.exe');
  const stdout = execFileSync(executable, ['inspect', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, BRC_DIAGNOSTICS_ENABLED: 'true' },
    windowsHide: true,
    timeout: 10000,
  });
  const output = JSON.parse(stdout);
  const names = new Set(output.diagnostics.functions.map((entry) => entry.name));
  for (const expected of [
    'main', 'positive_pids', 'inspect', 'windows::handle_identity', 'row',
    'diagnostics::enabled', 'diagnostics::new', 'diagnostics::drop',
    'diagnostics::record', 'diagnostics::function_rows',
    'diagnostics::resources', 'diagnostics::summary',
  ]) {
    assert.ok(names.has(expected), 'missing native function: ' + expected);
  }
  for (const entry of output.diagnostics.functions) {
    assert.ok(Number.isInteger(entry.calls) && entry.calls > 0, entry.name);
    assert.ok(Number.isFinite(entry.totalMs) && entry.totalMs >= 0, entry.name);
    assert.ok(Number.isFinite(entry.maxMs) && entry.maxMs >= 0, entry.name);
  }
});

