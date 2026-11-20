import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'brc-history-sqlite-'));
process.env.BRC_DATA_ROOT = path.join(root, 'home');
process.env.BRC_CONFIG_FILE = path.join(root, 'config', 'brc.yaml');
const { configureAgentServices } = await import('../packages/agent/dist/cli.js');
const services = await configureAgentServices();
const { toolHistory, dispatcher } = services;
const { SqliteToolHistoryStore } = await import('../packages/shared/dist/index.js');
const { ToolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
const output = { content: [{ type: 'text', text: 'ok' }] };

class MemoryStore {
  constructor() {
    this.entries = [];
    this.fail = false;
    this.failAt = undefined;
    this.appendCount = 0;
  }

  async append(entry) {
    this.appendCount += 1;
    if (this.fail || this.appendCount === this.failAt) throw new Error('write failed');
    this.entries.push(entry);
  }

  async query() {
    return [...this.entries].reverse();
  }

  async prune(max) {
    const excess = this.entries.length - max;
    if (excess <= 0) return 0;
    return this.entries.splice(0, excess).length;
  }

  async clear() {
    this.entries = [];
  }

  close() {}
}

function openStore(databasePath) {
  return new SqliteToolHistoryStore({ databasePath });
}

test('history persists entries in the unified SQLite store with a valid JSON payload', async () => {
  toolHistory.addCall('list_searches', {}, output);
  await toolHistory.cleanup();
  const store = openStore(toolHistory.target);
  try {
    const entries = await store.query({ maxResults: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].toolName, 'list_searches');
    assert.equal(JSON.parse(JSON.stringify(entries[0])).toolName, 'list_searches');
  } finally {
    store.close();
  }
  assert.equal(existsSync(path.join(process.env.BRC_DATA_ROOT, 'data', 'agent', 'tool-history.json')), false);
  assert.equal(existsSync(toolHistory.target), true);
});

test('history suppresses arguments and output content in the stored payload', async () => {
  const secret = 'history-private-argument';
  toolHistory.addCall('read_file', { path: secret }, { content: [{ type: 'text', text: secret }] });
  await toolHistory.cleanup();
  const store = openStore(toolHistory.target);
  try {
    const entries = await store.query({ maxResults: 10 });
    assert.doesNotMatch(JSON.stringify(entries), /history-private-argument/);
    assert.equal(entries[0].output.isError, false);
  } finally {
    store.close();
  }
});

test('history caps stored and in-memory entries at the configured maximum', async () => {
  const store = new MemoryStore();
  const history = new ToolHistory(store, () => {});
  for (let i = 0; i < 1001; i += 1) history.addCall(`call-${i}`, {}, output);
  assert.equal(history.getRecentCalls({ maxResults: 1000 }).length, 1000);
  await history.cleanup();
  assert.ok(store.entries.length <= 1000);
  assert.equal(store.entries.at(-1).toolName, 'call-1000');
});

test('history retains failed writes and retries them in order without duplicates', async () => {
  const store = new MemoryStore();
  const failures = [];
  const history = new ToolHistory(store, () => failures.push('failed'));
  store.fail = true;
  history.addCall('first', {}, output);
  await history.cleanup();
  assert.equal(failures.length, 1);
  assert.equal(history.getStats().queuedWrites, 1);
  store.fail = false;
  history.addCall('second', {}, output);
  await history.cleanup();
  assert.deepEqual(store.entries.map((entry) => entry.toolName), ['first', 'second']);
  assert.equal(history.getStats().queuedWrites, 0);
});

test('history retries only the unwritten suffix after a partial batch failure', async () => {
  const store = new MemoryStore();
  const failures = [];
  const history = new ToolHistory(store, () => failures.push('failed'));
  store.failAt = 2;
  history.addCall('first', {}, output);
  history.addCall('second', {}, output);
  history.addCall('third', {}, output);
  await history.cleanup();
  assert.equal(failures.length, 1);
  assert.deepEqual(store.entries.map((entry) => entry.toolName), ['first']);
  assert.equal(history.getStats().queuedWrites, 2);
  store.failAt = undefined;
  await history.cleanup();
  assert.deepEqual(store.entries.map((entry) => entry.toolName), ['first', 'second', 'third']);
  assert.equal(history.getStats().queuedWrites, 0);
});

test('multibyte history payloads round-trip through SQLite without corruption', async () => {
  const databasePath = path.join(root, 'multibyte.sqlite');
  const store = openStore(databasePath);
  const value = '中文🔥multi';
  try {
    await store.append({
      timestamp: new Date().toISOString(),
      toolName: 'read_file',
      arguments: {},
      output: { isError: false, content: [{ type: 'text', text: value }] },
    });
    const entries = await store.query({ maxResults: 10 });
    assert.equal(JSON.parse(JSON.stringify(entries[0])).output.content[0].text, value);
  } finally {
    store.close();
  }
});

test('loading sanitizes sensitive fields from an existing store', async () => {
  const store = new MemoryStore();
  store.entries.push({
    timestamp: new Date().toISOString(),
    toolName: 'read_file',
    arguments: { secret: 'old-private-argument' },
    output: { isError: true, content: [{ type: 'text', text: 'old-private-output' }] },
    extra: 'old-private-extra',
  });
  const history = new ToolHistory(store, () => {});
  await history.load();
  const records = history.getRecentCalls({ maxResults: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].toolName, 'read_file');
  assert.equal(records[0].output.isError, true);
  assert.doesNotMatch(JSON.stringify(records), /old-private-/);
});

test('dispatcher exposes successful and failed calls without private content', async () => {
  const { callTool } = dispatcher;
  const secret = 'history-dispatch-private-content';
  const success = await callTool('list_searches', {});
  assert.notEqual(success.isError, true);
  const failure = await callTool('read_file', { path: secret });
  assert.equal(failure.isError, true);
  const history = await callTool('get_recent_tool_calls', { maxResults: 1000 });
  assert.notEqual(history.isError, true);
  const text = history.content[0].text;
  assert.match(text, /list_searches/);
  assert.match(text, /read_file/);
  assert.match(text, /"isError": true/);
  assert.doesNotMatch(text, /history-dispatch-private-content/);
  await toolHistory.cleanup();
});

test('history failures do not alter dispatcher results', async () => {
  const { callTool } = dispatcher;
  const original = toolHistory.addCall;
  toolHistory.addCall = () => { throw new Error('history unavailable'); };
  try {
    const result = await callTool('list_searches', {});
    assert.notEqual(result.isError, true);
  } finally {
    toolHistory.addCall = original;
  }
});

test('injected dispatchers isolate history and report sanitized recording failures', async (t) => {
  const { createToolDispatcher } = await import('../packages/agent/dist/adapters/mcp/dispatcher.js');
  const { CommandManager } = await import('../packages/agent/dist/adapters/terminal/command-manager.js');
  const { TerminalManager } = await import('../packages/agent/dist/adapters/terminal/terminal-manager.js');
  const { VERSION } = await import('../packages/agent/dist/core/version.js');
  const firstStore = openStore(path.join(root, 'dispatcher-first.sqlite'));
  const secondStore = openStore(path.join(root, 'dispatcher-second.sqlite'));
  const firstHistory = new ToolHistory(firstStore, () => {});
  const secondHistory = new ToolHistory(secondStore, () => {});
  t.after(() => {
    firstStore.close();
    secondStore.close();
  });
  const failures = [];
  const filesystem = { configManager: services.configManager, capture: services.capture, fileHandlers: services.fileHandlers };
  const terminal = {
    ...filesystem,
    commandManager: new CommandManager(services.configManager, services.capture),
    terminalManager: new TerminalManager(services.configManager, services.capture),
  };
  const createDispatcher = (history) => createToolDispatcher({
    ...services,
    filesystem,
    terminal,
    transfer: { ...filesystem, receiveKeys: new Map() },
    currentClient: { name: 'brc-agent', version: VERSION },
    toolHistory: history,
    logHistoryFailure: (...args) => failures.push(args),
    trackToolCall: async () => {},
  });
  const first = createDispatcher(firstHistory);
  const second = createDispatcher(secondHistory);
  const secret = 'dispatcher-private-argument-body';
  const expected = await first.callTool('list_searches', { privateArgument: secret });
  assert.notEqual(expected.isError, true);
  await first.callTool('list_searches', {});
  await second.callTool('list_searches', {});
  assert.equal(firstHistory.getRecentCalls({}).length, 2);
  assert.equal(secondHistory.getRecentCalls({}).length, 1);
  await firstHistory.cleanup();
  await secondHistory.cleanup();
  const firstEntries = await firstStore.query({ maxResults: 10 });
  const secondEntries = await secondStore.query({ maxResults: 10 });
  assert.equal(firstEntries.length, 2);
  assert.equal(secondEntries.length, 1);
  assert.doesNotMatch(JSON.stringify(firstEntries), /dispatcher-private-argument-body/);
  const original = firstHistory.addCall;
  firstHistory.addCall = () => { throw new Error(secret); };
  try {
    const result = await first.callTool('list_searches', { privateArgument: secret });
    assert.deepEqual(result, expected);
    assert.equal(failures.length, 1);
    assert.doesNotMatch(JSON.stringify(failures), /dispatcher-private-argument-body/);
    assert.equal(secondHistory.getRecentCalls({}).length, 1);
  } finally {
    firstHistory.addCall = original;
  }
});

test.after(async () => {
  await toolHistory.cleanup();
  toolHistory.close();
  await rm(root, { recursive: true, force: true });
});
