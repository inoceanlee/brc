import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PROGRESS_FRAMES, progressFrame, clearProgressLine, formatElapsed } from '../packages/shared/dist/index.js';
import { TraefikProgress } from '../packages/cli/dist/adapters/terminal/progress.js';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const wait = () => new Promise((resolve) => setTimeout(resolve, 180));

test('shared progress primitives own the spinner and line clearing', () => {
  assert.deepEqual([...PROGRESS_FRAMES], ['|', '/', '-', '\\']);
  assert.equal(progressFrame(0), '|');
  assert.equal(progressFrame(5), '/');
  assert.equal(clearProgressLine(true), '\r\x1b[2K');
  assert.equal(clearProgressLine(false), '\r');
  assert.equal(formatElapsed(1500), '1.5s');
});

test('known totals render the completed count with the percentage', async () => {
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 50, totalBytes: 100 });
  await wait();
  assert.match(output.text, /50\/100 50%/);
  progress.stop();
});

test('CLI and release progress reuse the shared primitives', async () => {
  const cli = await source('../packages/cli/src/adapters/terminal/progress.ts');
  const release = await source('../scripts/release-progress.mjs');
  assert.match(cli, /progressFrame/);
  assert.match(cli, /clearProgressLine/);
  assert.match(release, /progressFrame/);
  assert.match(release, /clearProgressLine/);
  assert.match(release, /formatElapsed/);
});
