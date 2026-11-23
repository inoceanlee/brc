import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand, UsageError } from '../packages/cli/dist/commands/parser.js';

test('uninstall requires an explicit confirmation target', () => {
  assert.throws(() => parseCommand(['uninstall']), UsageError);
  assert.throws(() => parseCommand(['uninstall', '--yes']), UsageError);
  const confirmed = parseCommand(['uninstall', '--confirm', '/tmp/brc', '--yes']);
  assert.equal(confirmed.name, 'uninstall');
  assert.equal(confirmed.confirm, '/tmp/brc');
  assert.deepEqual(confirmed.args, ['--confirm', '/tmp/brc', '--yes']);
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

test('config missing arguments are named usage errors', () => {
  assert.throws(() => parseCommand(['config']), (error) => error.exitCode === 2 && /subcommand/i.test(error.message));
  assert.throws(() => parseCommand(['config', 'get']), (error) => error.exitCode === 2 && /<key>/.test(error.message));
  assert.throws(() => parseCommand(['config', 'set', 'proxy.rate.average']), (error) => error.exitCode === 2 && /<value>/.test(error.message));
  assert.throws(() => parseCommand(['config', 'nope']), (error) => error.exitCode === 2 && /nope/.test(error.message));
});

test('invalid syntax reports usage errors instead of running commands', () => {
  for (const argv of [['unknown'], ['start', 'extra'], ['logs', 'nope'], ['diagnose'], ['config', 'set', 'nope', '1'], ['status', 'extra']]) {
    assert.throws(() => parseCommand(argv), UsageError, argv.join(' '));
  }
});
