import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setConfigValue } from '../packages/agent/dist/adapters/mcp/tools/config.js';
import { FuzzySearchLogger } from '../packages/agent/dist/adapters/telemetry/fuzzySearchLogger.js';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('adapters route diagnostics through the injected log port', async () => {
  const files = [
    '../packages/agent/src/adapters/mcp/tools/config.ts',
    '../packages/agent/src/adapters/telemetry/fuzzySearchLogger.ts',
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

test('fuzzy search diagnostics reach the injected log port', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-fuzzy-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocker = path.join(root, 'blocker');
  await writeFile(blocker, 'not a directory');
  const captured = [];
  const log = {
    error: (message) => captured.push(message),
    warning: () => {},
    info: () => {},
  };
  const logger = new FuzzySearchLogger(blocker, 1024, log);
  await logger.getRecentLogs();
  assert.ok(captured.length > 0, 'injected log port receives the failure');
  assert.match(captured.join('\n'), /fuzzy search logs/i);
});

test('agent entry point injects the unified log into fuzzy search diagnostics', async () => {
  const cli = await source('../packages/agent/src/cli.ts');
  assert.match(cli, /new FuzzySearchLogger\([^\n]*logger\)/);
});

test('mcp entry point passes the unified log to tool adapters', async () => {
  const cli = await source('../packages/agent/src/cli.ts');
  assert.match(cli, /createToolDispatcher\(\{[\s\S]*log: logger,/);
  const dispatcher = await source('../packages/agent/src/adapters/mcp/dispatcher.ts');
  assert.match(dispatcher, /setConfigValue\(a, deps\.configManager, deps\.log\)/);
  const filesystem = await source('../packages/agent/src/adapters/filesystem/filesystem.ts');
  assert.match(filesystem, /log\?: TextLogPort/);
});
