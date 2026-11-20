import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-privacy-'));
process.env.BRC_DATA_ROOT = root;
process.env.DO_NOT_TRACK = '1';
const { configureAgentServices } = await import('../packages/agent/dist/cli.js');
const services = await configureAgentServices();
const { toolHistory, fuzzySearchLogger } = services;
const { trackToolCall } = await import('../packages/agent/dist/adapters/telemetry/trackTools.js');
const { DEFAULT_SETTINGS } = await import('../packages/shared/dist/index.js');
const privateText = 'private-secret-8328';

test('metadata tool-call log never persists raw arguments', async () => {
  await trackToolCall(path.join(root, 'logs'), DEFAULT_SETTINGS.logs.rotateMiB * 1024 * 1024, 'edit_block', { token: privateText, nested: { content: privateText } });
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
  const { SqliteToolHistoryStore } = await import('../packages/shared/dist/index.js');
  const store = new SqliteToolHistoryStore({ databasePath: toolHistory.target });
  try {
    const entries = await store.query({ maxResults: 10 });
    assert.doesNotMatch(JSON.stringify(entries), /private-secret/);
  } finally {
    store.close();
  }
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
  try { services.logger.info('safe operation'); } finally { process.stdout.write = original; }
  assert.equal(stdout, '');
});


test('config adapter logs do not disclose editable user values', async () => {
  const { setConfigValue, getConfig } = await import('../packages/agent/dist/adapters/mcp/tools/config.js');
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (value) => { captured += String(value); return true; };
  try {
    const updated = await setConfigValue({ key: 'allowedDirectories', value: ['private-secret-8328'] }, services.configManager);
    assert.notEqual(updated.isError, true);
    const { VERSION } = await import('../packages/agent/dist/core/version.js');
    const read = await getConfig({
      configManager: services.configManager,
      featureFlagManager: services.featureFlagManager,
      currentClient: { name: 'brc-agent', version: VERSION },
    });
    assert.notEqual(read.isError, true);
  } finally { process.stderr.write = original; }
  assert.doesNotMatch(captured, /private-secret-8328/);
});

test('usage statistics and onboarding diagnostics do not write to stdout', () => {
  const script = `
    const { configureAgentServices } = await import(${JSON.stringify(new URL('../packages/agent/dist/cli.js', import.meta.url).href)});
    const { usageTracker } = await configureAgentServices();
    await usageTracker.resetOnboardingState();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BRC_DATA_ROOT: path.join(root, 'usage-child') }, encoding: 'utf8', timeout: 6000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test.after(() => {
  toolHistory.close();
  rmSync(root, { recursive: true, force: true });
});

test('Agent logger forwards redacted events into the injected Shared diagnostic sink', async () => {
  const { createAgentLogger } = await import('../packages/agent/dist/adapters/telemetry/logger.js');
  const first = createAgentLogger();
  const second = createAgentLogger();
  const received = [];
  const other = [];
  const dispose = first.bind((level, message) => received.push({ level, message }));
  const disposeOther = second.bind((level, message) => other.push({ level, message }));
  first.info('Bearer private-secret-8328');
  dispose();
  second.info('second instance');
  disposeOther();
  assert.deepEqual(received, [{ level: 'info', message: 'Bearer [redacted]' }]);
  assert.deepEqual(other, [{ level: 'info', message: 'second instance' }]);
});


test('telemetry opt-in remains bound to the Agent instance environment', async () => {
  const { createCapture } = await import('../packages/agent/dist/adapters/telemetry/capture.js');
  const original = process.env.BRC_UPSTREAM_TELEMETRY;
  let reads = 0;
  try {
    process.env.BRC_UPSTREAM_TELEMETRY = '1';
    const { capture } = createCapture({
      env: { BRC_UPSTREAM_TELEMETRY: '0' },
      configManager: { getOrCreateClientId: async () => { reads++; return 'id'; } },
      getContext: () => ({ currentClient: null, currentCallIsRemote: false, currentRemoteClient: null }),
      getSystemInfo: () => { throw new Error('disabled telemetry must not collect system data'); },
    });
    await capture('instance-test');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 0);
  } finally {
    if (original === undefined) delete process.env.BRC_UPSTREAM_TELEMETRY;
    else process.env.BRC_UPSTREAM_TELEMETRY = original;
  }
});