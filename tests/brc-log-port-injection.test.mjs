import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setConfigValue } from '../packages/agent/dist/adapters/mcp/tools/config.js';
import { FuzzySearchLogger } from '../packages/agent/dist/adapters/telemetry/fuzzySearchLogger.js';

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
