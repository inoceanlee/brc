import assert from 'node:assert/strict';
import { test } from 'node:test';

const resourcesUrl = new URL('../packages/cli/dist/adapters/process/resources.js', import.meta.url).href;

test('native sample payload converts only found rows into raw samples', async () => {
  const { parseNativeSamplePayload } = await import(resourcesUrl);
  const payload = {
    samples: [{
      pid: 4242,
      status: 'found',
      cpuUserMs: 12.5,
      cpuSystemMs: 3.25,
      cpuPercent: null,
      rssBytes: 4096,
      systemPeakBytes: 8192,
      peak: { source: 'system', rssBytes: 8192, windowMs: 0 },
      unavailable: null,
    }],
  };
  assert.deepEqual(parseNativeSamplePayload(payload, 4242), {
    cpuUserMs: 12.5,
    cpuSystemMs: 3.25,
    cpuPercent: null,
    rssBytes: 4096,
    systemPeakBytes: 8192,
  });
});

test('native sample payload checks status before numeric fields', async () => {
  const { parseNativeSamplePayload } = await import(resourcesUrl);
  const missing = {
    samples: [{
      pid: 4242, status: 'not_found', cpuUserMs: 12, cpuSystemMs: 3,
      cpuPercent: null, rssBytes: 4096, systemPeakBytes: null, unavailable: 'PROCESS_NOT_FOUND',
    }],
  };
  assert.throws(() => parseNativeSamplePayload(missing, 4242), /PROCESS_NOT_FOUND/);
  const failed = {
    samples: [{
      pid: 4242, status: 'error', cpuUserMs: 12, cpuSystemMs: 3,
      cpuPercent: null, rssBytes: 4096, systemPeakBytes: null, unavailable: 'ACCESS_DENIED', code: 'ACCESS_DENIED',
    }],
  };
  assert.throws(() => parseNativeSamplePayload(failed, 4242), /ACCESS_DENIED/);
});

