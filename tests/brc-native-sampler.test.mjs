import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const resourcesUrl = new URL('../packages/cli/dist/adapters/process/resources.js', import.meta.url).href;
const resourcesSource = fileURLToPath(new URL('../packages/cli/src/adapters/process/resources.ts', import.meta.url));

test('native sampling is the only process resource sampling implementation in the CLI adapter', async () => {
  const source = await readFile(resourcesSource, 'utf8');
  assert.doesNotMatch(source, /sampleWindows|sampleLinux|sampleDarwin|powershell\.exe|getconf/);
  assert.match(source, /NATIVE_PROCESS_BINARY/);
  assert.match(source, /\['sample', String\(pid\)\]/);
  assert.match(source, /value\.status !== 'found'/);
});

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

test('native sampler invokes one native program with the sample subcommand', async () => {
  const { createNativeProcessSample } = await import(resourcesUrl);
  const calls = [];
  const sample = createNativeProcessSample({
    executablePath: 'C:/tools/brc-process.exe',
    run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify({ samples: [{
        pid: 77, status: 'found', cpuUserMs: 1, cpuSystemMs: 2, cpuPercent: null,
        rssBytes: 3, systemPeakBytes: null, unavailable: null,
      }] }) };
    },
  });
  assert.deepEqual(await sample(77), {
    cpuUserMs: 1, cpuSystemMs: 2, cpuPercent: null, rssBytes: 3, systemPeakBytes: null,
  });
  assert.deepEqual(calls, [['C:/tools/brc-process.exe', ['sample', '77']]]);
});
