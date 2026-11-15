import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand, UsageError } from '../packages/cli/dist/commands/parser.js';

test('bare uninstall stays an interactive command with an optional --yes', () => {
  const bare = parseCommand(['uninstall']);
  assert.equal(bare.name, 'uninstall');
  assert.deepEqual(bare.args, []);
  const confirmed = parseCommand(['uninstall', '--yes']);
  assert.deepEqual(confirmed.args, ['--yes']);
  assert.throws(() => parseCommand(['uninstall', '--force']), UsageError);
});

test('global flags are accepted anywhere and do not change the command', () => {
  const parsed = parseCommand(['start', '--timing', '--quiet']);
  assert.equal(parsed.name, 'start');
  assert.equal(parsed.timing, true);
  assert.equal(parsed.quiet, true);
  assert.equal(parseCommand(['--verbose', 'status', '--json']).json, true);
  assert.equal(parseCommand(['--no-input', 'setup']).name, 'setup');
});

test('per-command help and version are explicit commands', () => {
  assert.equal(parseCommand(['stop', '--help']).name, 'help');
  assert.deepEqual(parseCommand(['help', 'start']).args, ['start']);
  assert.equal(parseCommand(['--version']).name, 'version');
  assert.equal(parseCommand(['version', '--json']).json, true);
  assert.throws(() => parseCommand(['version', '--extra']), UsageError);
});

test('invalid syntax reports usage errors instead of running commands', () => {
  for (const argv of [['unknown'], ['start', 'extra'], ['logs', 'nope'], ['diagnose'], ['config', 'set', 'nope', '1'], ['status', 'extra']]) {
    assert.throws(() => parseCommand(argv), UsageError, argv.join(' '));
  }
});
