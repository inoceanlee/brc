import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-privacy-'));
process.env.BRC_DATA_ROOT = root;
process.env.BRC_HOME = root;
process.env.DO_NOT_TRACK = '1';
const { configureAgentServices } = await import('../packages/agent/dist/composition.js');
configureAgentServices();
const { trackToolCall } = await import('../packages/agent/dist/adapters/telemetry/trackTools.js');
const { toolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
const { fuzzySearchLogger } = await import('../packages/agent/dist/adapters/telemetry/fuzzySearchLogger.js');
const { logger } = await import('../packages/agent/dist/adapters/telemetry/logger.js');
const privateText = 'private-secret-8328';

test('metadata tool-call log never persists raw arguments', async () => {
  await trackToolCall('edit_block', { token: privateText, nested: { content: privateText } });
  const file = path.join(root, 'logs', 'agent-tool-calls.log');
  assert.equal(existsSync(file), true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /edit_block/);
  assert.doesNotMatch(text, /private-secret|content|token/);
});

test('tool history suppresses arguments and returned data even when short', async () => {
  toolHistory.addCall('read_file', { path: privateText }, { content: [{ type: 'text', text: privateText }] });
  const record = toolHistory.getRecentCalls({ maxResults: 1 })[0];
  assert.equal(record.toolName, 'read_file');
  assert.doesNotMatch(JSON.stringify(record), /private-secret/);
  await toolHistory.cleanup();
  const file = path.join(root, 'data', 'agent', 'tool-history.json');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /private-secret/);
});

test('fuzzy-search diagnostics retain measurements but not source text', async () => {
  await fuzzySearchLogger.log({
    timestamp: new Date(), searchText: privateText, foundText: privateText,
    similarity: 1, executionTime: 2, exactMatchCount: 1, expectedReplacements: 1,
    fuzzyThreshold: 0.8, belowThreshold: false, diff: privateText,
    searchLength: 20, foundLength: 20, fileExtension: '.txt',
    characterCodes: privateText, uniqueCharacterCount: 9, diffLength: 20,
  });
  const file = await fuzzySearchLogger.getLogPath();
  const content = readFileSync(file, 'utf8');
  assert.doesNotMatch(content, /private-secret/);
  assert.match(content, /similarity/);
});

test('agent logging never writes unsolicited JSON-RPC messages to stdout', () => {
  let stdout = '';
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  try { logger.info('safe operation'); } finally { process.stdout.write = original; }
  assert.equal(stdout, '');
});


test('config adapter logs do not disclose editable user values', async () => {
  const { setConfigValue, getConfig } = await import('../packages/agent/dist/adapters/mcp/tools/config.js');
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (value) => { captured += String(value); return true; };
  try {
    const updated = await setConfigValue({ key: 'allowedDirectories', value: ['private-secret-8328'] });
    assert.notEqual(updated.isError, true);
    const read = await getConfig();
    assert.notEqual(read.isError, true);
  } finally { process.stderr.write = original; }
  assert.doesNotMatch(captured, /private-secret-8328/);
});

test('usage statistics and onboarding diagnostics do not write to stdout', () => {
  const script = `
    const { configureAgentServices } = await import(${JSON.stringify(new URL('../packages/agent/dist/composition.js', import.meta.url).href)});
    configureAgentServices();
    const { usageTracker } = await import(${JSON.stringify(new URL('../packages/agent/dist/adapters/telemetry/usageTracker.js', import.meta.url).href)});
    await usageTracker.resetOnboardingState();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BRC_DATA_ROOT: path.join(root, 'usage-child') }, encoding: 'utf8', timeout: 6000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test.after(() => rmSync(root, { recursive: true, force: true }));

test('Agent logger forwards redacted events into the injected Shared diagnostic sink', async () => {
  const { installAgentLogSink } = await import('../packages/agent/dist/adapters/telemetry/logger.js');
  const received = [];
  const dispose = installAgentLogSink((level, message) => received.push({ level, message }));
  try { logger.info('Bearer private-secret-8328'); }
  finally { dispose(); }
  assert.deepEqual(received, [{ level: 'info', message: 'Bearer [redacted]' }]);
});
