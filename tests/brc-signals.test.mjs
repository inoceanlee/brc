import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { installCancellationHandlers, SIGNAL_EXIT_CODES } from '../packages/cli/dist/commands/signals.js';

test('SIGINT and SIGTERM flush once and exit with conventional codes', async () => {
  const source = new EventEmitter();
  const exits = [];
  let flushes = 0;
  const dispose = installCancellationHandlers({
    flush: async () => { flushes += 1; },
    exit: (code) => exits.push(code),
    signalSource: source,
  });
  source.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT]);
  source.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [SIGNAL_EXIT_CODES.SIGINT, SIGNAL_EXIT_CODES.SIGTERM]);
  assert.equal(flushes, 1, 'flush must not repeat while it is still running');
  dispose();
  source.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exits.length, 2, 'disposed handlers must not react');
});

test('a failing flush still exits with the signal code', async () => {
  const source = new EventEmitter();
  const exits = [];
  installCancellationHandlers({
    flush: async () => { throw new Error('disk full'); },
    exit: (code) => exits.push(code),
    signalSource: source,
  });
  source.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [143]);
});

test('signal cancellation aborts the active command before flushing diagnostics', async () => {
  const source = new EventEmitter();
  const order = [];
  const dispose = installCancellationHandlers({
    abort: (signal) => order.push('abort:' + signal),
    flush: async () => { order.push('flush'); },
    exit: (code) => order.push('exit:' + code),
    signalSource: source,
  });
  source.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['abort:SIGTERM', 'flush', 'exit:143']);
  dispose();
});
