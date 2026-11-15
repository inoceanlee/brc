import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TraceRecorder } from '../packages/shared/dist/diagnostics/core/recorder.js';

test('trace accounts for nested stages once and preserves unassigned duration', async () => {
  let elapsed = 0;
  const trace = new TraceRecorder('start', 'run-1', () => elapsed, '2026-11-15T00:00:00Z');
  const outer = trace.begin('lifecycle');
  elapsed = 10;
  const inner = trace.begin('health', 'relay');
  elapsed = 30;
  inner.end();
  elapsed = 40;
  outer.end();
  elapsed = 50;
  const summary = trace.finish('ok');
  assert.equal(summary.durationMs, 50);
  assert.equal(summary.accountedMs, 40);
  assert.equal(summary.unaccountedMs, 10);
  assert.deepEqual(summary.stages.map(({ stage, durationMs }) => [stage, durationMs]), [['health', 20], ['lifecycle', 40]]);
  assert.equal(summary.runId, 'run-1');
  assert.equal(summary.traceSchema, 1);
});

test('trace saves failed stage without storing sensitive exception content', async () => {
  let elapsed = 0;
  const trace = new TraceRecorder('start', 'run-2', () => elapsed);
  await assert.rejects(trace.span('spawn', async () => {
    elapsed = 17;
    throw new Error('password=my-secret');
  }), /my-secret/);
  const summary = trace.finish('failed', 'SERVICE_START_FAILED');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.errorCode, 'SERVICE_START_FAILED');
  assert.equal(summary.stages[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(summary), /my-secret/);
});
