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
});
