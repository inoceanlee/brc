import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

test('sync and async calls aggregate count, total, max and async wall time separately', async () => {
  let elapsed = 0;
  const timing = new FunctionTiming({ clock: () => elapsed });
  const sync = timing.begin('sync-id');
  elapsed = 4;
  timing.end(sync);
  const asyncToken = timing.begin('async-id', 'async');
  elapsed = 26;
  timing.end(asyncToken);
  const again = timing.begin('sync-id');
  elapsed = 34;
  timing.end(again);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.totalCalls, 3);
  const byId = Object.fromEntries(snapshot.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId['sync-id'].calls, 2);
  assert.equal(byId['sync-id'].totalMs, 12);
  assert.equal(byId['sync-id'].maxMs, 8);
  assert.equal(byId['sync-id'].asyncWallMs, 0);
  assert.equal(byId['async-id'].calls, 1);
  assert.equal(byId['async-id'].asyncWallMs, 22);
  assert.equal(snapshot.entries[0].id, 'async-id');
});

test('recursive and re-entrant calls count once for time but always for calls', () => {
  let elapsed = 0;
  const timing = new FunctionTiming({ clock: () => elapsed });
  const outer = timing.begin('recursive');
  elapsed = 2;
  const inner = timing.begin('recursive');
  elapsed = 5;
  timing.end(inner);
  elapsed = 9;
  timing.end(outer);
  const [entry] = timing.snapshot().entries;
  assert.equal(entry.calls, 2);
  assert.equal(entry.totalMs, 9);
  assert.equal(entry.maxMs, 9);
});

test('bounded aggregation drops unknown ids instead of growing without limit', () => {
  const timing = new FunctionTiming({ maxEntries: 2, clock: () => 0 });
  for (const id of ['a', 'b', 'c', 'd']) timing.end(timing.begin(id));
  const snapshot = timing.snapshot();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.droppedIds, 2);
  assert.equal(snapshot.totalCalls, 2);
});

test('failures are counted and snapshot ordering is by accumulated cost', () => {
  let elapsed = 0;
  const timing = new FunctionTiming({ clock: () => elapsed });
  const slow = timing.begin('slow');
  elapsed = 50;
  timing.end(slow);
  const failing = timing.begin('failing');
  elapsed = 55;
  timing.end(failing, true);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.entries[0].id, 'slow');
  assert.equal(snapshot.entries.find((entry) => entry.id === 'failing').errors, 1);
});

test('probe installation follows the disabled-by-default global hook contract', () => {
  const host = {};
  const timing = new FunctionTiming({ clock: () => 0 });
  assert.equal(host.__brcDiagBegin, undefined);
  const installation = installFunctionProbe(timing, host);
  const token = host.__brcDiagBegin('instrumented-id', 'sync');
  host.__brcDiagEnd(token);
  assert.equal(timing.snapshot().entries[0].id, 'instrumented-id');
  installation.uninstall();
  assert.equal(host.__brcDiagBegin, undefined);
});
