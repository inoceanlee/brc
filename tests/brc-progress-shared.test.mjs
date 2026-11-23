import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TraefikProgress } from '../packages/cli/dist/adapters/terminal/progress.js';

const wait = () => new Promise((resolve) => setTimeout(resolve, 180));

test('known totals render the completed count with the percentage', async () => {
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 50, totalBytes: 100 });
  await wait();
  assert.match(output.text, /50\/100 50%/);
  progress.stop();
});
