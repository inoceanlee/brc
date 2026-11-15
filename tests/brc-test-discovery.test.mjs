import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { discoverUnitTests, runUnitTests } from '../scripts/test-unit.mjs';

test('unit discovery includes existing and newly named suites without package E2E', async () => {
  const files = await discoverUnitTests();
  assert.ok(files.includes('packages/relay/test/unit.test.mjs'));
  assert.ok(files.includes('tests/brc-test-discovery.test.mjs'));
  assert.ok(files.includes('tests/brc-cli.test.mjs'));
  assert.ok(files.includes('tests/brc-config.test.mjs'));
  assert.ok(files.includes('tests/brc-diagnostics-snapshots.test.mjs'));
  assert.ok(!files.includes('tests/brc-package.test.mjs'));
  assert.ok(files.every((file) => file.endsWith('.test.mjs')));
  assert.deepEqual(files, [...new Set(files)].sort());
});

test('unit runner forwards every discovered suite and reports failures', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 3, null));
    return child;
  };
  const code = await runUnitTests(['tests/a.test.mjs', 'tests/b.test.mjs'], { spawn, cwd: 'fixture' });
  assert.equal(code, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.filter((arg) => arg.endsWith('.test.mjs')), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(calls[0].options.cwd, 'fixture');
});

test('unit runner treats a killed child as failure', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return child;
  };
  assert.equal(await runUnitTests(['tests/a.test.mjs'], { spawn }), 1);
});
