import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiagnosticsRuntime } from '../packages/shared/dist/diagnostics/runtime.js';

test('diagnostics runtime uses supplied ports without constructing adapters', async () => {
  const calls = [];
  const log = {
    write: async (entry) => { calls.push(['write', entry.message]); },
    flush: async () => { calls.push(['flush']); },
  };
  const session = {
    start: () => { calls.push(['session-start']); },
    capture: async (state) => { calls.push(['capture', state]); },
    stop: async () => { calls.push(['session-stop']); },
  };
  const resources = {
    start: () => { calls.push(['resource-start']); },
    stop: () => { calls.push(['resource-stop']); },
  };
  const runtime = createDiagnosticsRuntime({
    enabled: true, component: 'cli', instanceId: 'test',
    log, session, resources, functions: { snapshot: () => ({ entries: [] }) },
  });
  runtime.log('ready', { source: { file: 'test.ts' } });
  await runtime.captureSnapshot();
  await runtime.stop();
  assert.deepEqual(calls, [
    ['resource-start'], ['session-start'], ['write', 'ready'],
    ['capture', 'running'], ['resource-stop'], ['session-stop'], ['flush'],
  ]);
});

test('disabled diagnostics leave supplied adapters untouched', async () => {
  const runtime = createDiagnosticsRuntime({ enabled: false, component: 'agent' });
  runtime.log('ignored');
  await runtime.captureSnapshot();
  await runtime.stop();
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.getLogFailure(), undefined);
});

test('diagnostics flushes queued records before a snapshot and on shutdown', async () => {
  const events = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runtime = createDiagnosticsRuntime({
    enabled: true,
    component: 'agent',
    instanceId: 'agent-test',
    log: {
      write: async (event) => { await pending; events.push(event); },
      flush: async () => { events.push('flushed'); },
    },
    session: {
      start() {},
      capture: async (status) => { events.push(status); },
      stop: async () => { events.push('stopped'); },
    },
  });
  runtime.log('failure', { level: 'error', error: new Error('sample') });
  const snapshot = runtime.captureSnapshot();
  release();
  await snapshot;
  await runtime.stop();
  assert.equal(events[0].component, 'agent');
  assert.equal(events[0].instanceId, 'agent-test');
  assert.match(events[0].stack, /sample/);
  assert.deepEqual(events.slice(1), ['running', 'stopped', 'flushed']);
});

test('diagnostics reports a failed log write after later writes succeed', async () => {
  const failure = new Error('diagnostic log unavailable');
  let writes = 0;
  let stopped = false;
  const runtime = createDiagnosticsRuntime({
    enabled: true,
    component: 'agent',
    log: {
      async write() { if (++writes === 1) throw failure; },
      async flush() {},
    },
    session: {
      start() {},
      async capture() {},
      async stop() { stopped = true; },
    },
  });
  runtime.log('first');
  runtime.log('second');
  await assert.rejects(runtime.stop(), failure);
  assert.equal(writes, 2);
  assert.equal(stopped, true);
});

test('stop shares cleanup and preserves all failures including first log error', async () => {
  const first = new Error('first write');
  const resource = new Error('resource stop');
  const session = new Error('session stop');
  const flush = new Error('flush');
  const calls = [];
  const runtime = createDiagnosticsRuntime({
    enabled: true, component: 'cli',
    resources: { start() {}, stop() { calls.push('resource'); throw resource; } },
    session: { start() {}, async capture() {}, async stop() { calls.push('session'); throw session; } },
    log: {
      async write() { throw first; },
      async flush() { calls.push('flush'); throw flush; },
    },
  });
  runtime.log('failure');
  await runtime.captureSnapshot();
  assert.equal(runtime.getLogFailure(), first);
  const one = runtime.stop();
  const two = runtime.stop();
  assert.equal(one, two);
  await assert.rejects(one, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [resource, session, flush, first]);
    return true;
  });
  assert.deepEqual(calls, ['resource', 'session', 'flush']);
});
