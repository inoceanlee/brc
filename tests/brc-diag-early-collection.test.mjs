import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

test('calls made before probe installation are buffered and merged on install', () => {
  const host = {};
  let now = 0;
  const early = globalThis[Symbol.for('brc.diag.early')];

  assert.ok(early, 'early-call buffer must exist before probe installation');
  const token = early.begin('early-fn', 'sync', now);
  now = 7;
  early.end(token, false, now);

  const timing = new FunctionTiming({ clock: () => now });
  installFunctionProbe(timing, host);

  const entry = timing.snapshot().entries.find((item) => item.id === 'early-fn');
  assert.ok(entry, 'buffered early call must appear after installation');
  assert.equal(entry.calls, 1);
  assert.equal(entry.totalMs, 7);
});

test('early buffer is bounded and does not grow without limit', () => {
  const early = globalThis[Symbol.for('brc.diag.early')];
  assert.ok(early);
  const fresh = early.fork();
  for (let index = 0; index < 5000; index += 1) {
    const token = fresh.begin('fn-' + index, 'sync', 0);
    fresh.end(token, false, 1);
  }
  assert.ok(fresh.count <= 2000, 'early buffer must be bounded');
});
