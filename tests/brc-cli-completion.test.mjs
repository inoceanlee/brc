import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repository, 'packages', 'cli', 'dist', 'cli.js');
const version = JSON.parse(await readFile(path.join(repository, 'packages', 'cli', 'package.json'), 'utf8')).version;
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: path.join(repository, '..', 'brc-completion-test-root') },
  });
}

test('every command help carries copyable examples and the versioned docs link', async () => {
  const { COMMAND_SPECS } = await import(new URL('../packages/cli/dist/commands/parser.js', import.meta.url).href);
  const docs = `https://github.com/inoceanlee/brc/tree/v${version}`;
  for (const spec of COMMAND_SPECS) {
    assert.ok(spec.examples.length >= 2, spec.name);
    const result = invoke('help', spec.name);
    assert.equal(result.status, 0, spec.name + result.stderr);
    assert.match(result.stdout, /Examples:/, spec.name);
    assert.match(result.stdout, new RegExp(docs.replaceAll('.', '\\.')), spec.name);
  }
});

test('top-level help carries the same versioned docs link', () => {
  const result = invoke('help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`https://github\\.com/inoceanlee/brc/tree/v${version.replaceAll('.', '\\.')}`));
});

test('unknown command suggests the closest registered command', () => {
  const result = invoke('strt');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Did you mean "start"\?/);
});

test('completion scripts list subcommands and global flags from the command definitions', () => {
  for (const shell of ['powershell', 'bash', 'zsh', 'fish']) {
    const result = invoke('completion', shell);
    assert.equal(result.status, 0, shell + result.stderr);
    for (const token of ['start', 'diagnose', 'completion', '--json', '--preview', '--output']) {
      assert.match(result.stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), shell + ' ' + token);
    }
  }
});
