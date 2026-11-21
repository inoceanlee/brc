import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setConfigValue } from '../packages/agent/dist/adapters/mcp/tools/config.js';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('adapters route diagnostics through the injected log port', async () => {
  const files = [
    '../packages/agent/src/adapters/mcp/tools/config.ts',
    '../packages/agent/src/adapters/filesystem/pdf/extract-images.ts',
    '../packages/agent/src/adapters/filesystem/pdf/markdown.ts',
    '../packages/agent/src/adapters/mcp/dispatcher.ts',
    '../packages/agent/src/adapters/filesystem/filesystem.ts',
    '../packages/relay/src/adapters/storage/legacy-import.ts',
  ];
  for (const file of files) {
    const text = await source(file);
    assert.doesNotMatch(text, /console\.(error|warn)/, file);
  }
});

test('config tool reports diagnose messages to the provided port', async () => {
  const captured = [];
  const log = {
    error: (message) => captured.push(message),
    warning: (message) => captured.push(message),
    info: () => {},
  };
  const result = await setConfigValue({ key: 'not-a-setting' }, {}, log);
  assert.equal(result.isError, true);
  assert.ok(captured.length > 0, 'injected log port receives the diagnostic');
});

test('Docker debug stdout remains user-visible and unchanged', async () => {
  const text = await source('../packages/agent/src/adapters/mcp/docker-prompt.ts');
  assert.match(text, /console\.log\(`\[DOCKER DEBUG\]/);
});
