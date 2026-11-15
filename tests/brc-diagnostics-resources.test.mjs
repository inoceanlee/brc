import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeResourceSampler, sampleNodeResources } from '../packages/shared/dist/diagnostics/adapters/resources-node.js';

test('sampler reports CPU time, RSS, heap and an explicitly sourced peak', async (t) => {
  const sampler = new NodeResourceSampler({ intervalMs: 100 });
  t.after(() => sampler.stop());
  sampler.start();
  const first = await sampler.sample();
  assert.equal(first.schema, 1);
  assert.equal(first.source, 'node');
  assert.ok(first.rssBytes > 0);
  assert.ok(first.heapUsedBytes > 0);
  assert.ok(first.cpuUserMs >= 0);
  assert.ok(first.cpuSystemMs >= 0);
  assert.ok(first.peak);
  assert.ok(first.peak.rssBytes >= first.rssBytes || first.peak.source === 'system');
  assert.ok(['system', 'sampled'].includes(first.peak.source));
  assert.ok(first.peak.windowMs >= 0);
});

test('sampling window accumulates CPU percentage and sampled peak', async (t) => {
  const sampler = new NodeResourceSampler({ intervalMs: 100 });
  t.after(() => sampler.stop());
  sampler.start();
  const until = Date.now() + 350;
  while (Date.now() < until) {
    const now = Date.now();
    while (Date.now() - now < 25) { /* busy work keeps CPU percent measurable */ }
  }
  sampler.stop();
  const sample = await sampler.sample();
  assert.notEqual(sample.cpuPercent, null);
  assert.ok(sample.windowMs >= 250);
  assert.equal(sample.peak.source, process.platform === 'linux' ? 'system' : 'sampled');
});

test('short-lived sampling helper returns a usable sample without timers left behind', async () => {
  const sample = await sampleNodeResources(150);
  assert.ok(sample.capturedAt);
  assert.ok(sample.rssBytes > 0);
  const handles = process.getActiveResourcesInfo?.() ?? [];
  assert.equal(handles.filter((name) => name === 'Timeout').length, 0);
});

test('invalid sampling intervals are rejected', () => {
  assert.throws(() => new NodeResourceSampler({ intervalMs: 1 }), /between 100 and 60000/);
});
