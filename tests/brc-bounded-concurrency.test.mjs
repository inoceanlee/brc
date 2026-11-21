import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mapWithConcurrency, DEFAULT_FILE_READ_CONCURRENCY, DEFAULT_PDF_IMAGE_BATCH_SIZE } from '../packages/shared/dist/index.js';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

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

test('file reads use a configured concurrency limit', async () => {
  assert.ok(DEFAULT_FILE_READ_CONCURRENCY >= 1);
  const text = await source('../packages/agent/src/adapters/filesystem/filesystem.ts');
  assert.doesNotMatch(text, /Promise\.all\(\s*paths\.map/);
  assert.match(text, /mapWithConcurrency/);
  assert.match(text, /DEFAULT_FILE_READ_CONCURRENCY/);
});

test('PDF image batch size comes from configuration', async () => {
  assert.equal(DEFAULT_PDF_IMAGE_BATCH_SIZE, 5);
  const text = await source('../packages/agent/src/adapters/filesystem/pdf/extract-images.ts');
  assert.doesNotMatch(text, /batchSize\s*=\s*5/);
  assert.match(text, /DEFAULT_PDF_IMAGE_BATCH_SIZE/);
});
