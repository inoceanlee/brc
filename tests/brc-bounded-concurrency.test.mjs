import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapWithConcurrency } from '../packages/shared/dist/index.js';

test('bounded map keeps order and caps concurrent work', async () => {
  let active = 0;
  let peak = 0;
  const input = Array.from({ length: 20 }, (_, index) => index);
  const results = await mapWithConcurrency(input, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, input.map((value) => value * 2));
});
