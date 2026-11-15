import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const source = path.join('native', 'brc-process', 'src');

test('native process helper functions have timed execution scopes', async () => {
  const windows = await readFile(path.join(source, 'windows.rs'), 'utf8');
  const definitions = [...windows.matchAll(/\bfn\s+([a-z_]+)(?:\s*<[^>]+>)?\s*\(/g)]
    .map((match) => match[1]);
  const scoped = [...windows.matchAll(/ScopeTimer::new\("(?:windows::)?([a-z_]+)"\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(scoped.slice().sort(), definitions.map((name) => name === 'drop' ? 'drop_handle' : name).sort());
  const identity = await readFile(path.join(source, 'identity.rs'), 'utf8');
  assert.match(identity, /ScopeTimer::new\("positive_pids"\)/);
  assert.match(identity, /ScopeTimer::new\("row"\)/);
  const main = await readFile(path.join(source, 'main.rs'), 'utf8');
  assert.match(main, /diagnostics::record\("main"/);
});

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
  for (const expected of ['main', 'positive_pids', 'inspect', 'windows::handle_identity', 'row']) {
    assert.ok(names.has(expected), 'missing native function: ' + expected);
  }
});
