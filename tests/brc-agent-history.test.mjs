import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'brc-history-'));
process.env.BRC_DATA_ROOT = path.join(root, 'home');
const { configureAgentServices } = await import('../packages/agent/dist/composition.js');
configureAgentServices();
const { toolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
const { fuzzySearchLogger } = await import('../packages/agent/dist/adapters/telemetry/fuzzySearchLogger.js');
const { resolveAgentPaths } = await import('../packages/agent/dist/adapters/storage/agent-paths.js');
const { ToolHistoryStorage } = await import('../packages/agent/dist/adapters/telemetry/toolHistoryStorage.js');
const file = path.join(resolveAgentPaths().historyDirectory, 'tool-history.json');
const output = { content: [{ type: 'text', text: 'ok' }] };

test('history retains failed writes and retries them in order without duplicates', async () => {
  await mkdir(file);
  toolHistory.addCall('first', {}, output);
  await toolHistory.cleanup();
  assert.equal(toolHistory.getStats().queuedWrites, 1);
  toolHistory.addCall('second', {}, output);
  await rm(file, { recursive: true });
  await toolHistory.cleanup();
  const records = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(records.map(record => record.toolName), ['first', 'second']);
  assert.equal(toolHistory.getStats().queuedWrites, 0);
});

test('history caps cache and oversized output while preserving insertion order', async () => {
  for (let i = 0; i < 1001; i++) toolHistory.addCall(`call-${i}`, {}, output);
  toolHistory.addCall('large', {}, { content: [{ type: 'text', text: 'x'.repeat(5000) }] });
  const records = toolHistory.getRecentCalls({ maxResults: 1000 });
  assert.equal(records.length, 1000);
  assert.equal(records[0].toolName, 'call-2');
  assert.match(records.at(-1).output.content[0].text, /tool output omitted/);
  await toolHistory.cleanup();
});

test('history compaction keeps newest complete lines within the target', async () => {
  const line = (n) => JSON.stringify({ n, value: 'x'.repeat(1024 * 1024) });
  await writeFile(file, JSON.stringify(Array.from({ length: 6 }, (_, i) => JSON.parse(line(i)))));
  toolHistory.addCall('after-trim', {}, output);
  await toolHistory.cleanup();
  const records = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(records.slice(0, -1).map(record => record.n), [3, 4, 5]);
  assert.equal(records.at(-1).toolName, 'after-trim');
});

test('history and fuzzy logger share the resolved agent home', async () => {
  assert.equal(toolHistory.getStats().historyFile, file);
  assert.equal(await fuzzySearchLogger.getLogPath(), path.join(resolveAgentPaths().logsDirectory, 'fuzzy-search.log'));
});

test('storage reads, appends and rewrites JSONL without altering text', async () => {
  const storage = new ToolHistoryStorage(path.join(root, 'storage'));
  assert.equal(storage.readText(), null);
  storage.appendText('{"n":1}\n');
  storage.appendText('{"n":2}\n');
  assert.equal(storage.readText(), '{"n":1}\n{"n":2}\n');
  storage.rewriteText('{"n":2}\n');
  assert.equal(storage.readText(), '{"n":2}\n');
});

test('simultaneous additions retain their order in the persisted queue', async () => {
  await writeFile(file, '[]');
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    toolHistory.addCall(`parallel-${i}`, {}, output);
  })));
  await toolHistory.cleanup();
  const records = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(records.map(record => record.toolName), Array.from({ length: 20 }, (_, i) => `parallel-${i}`));
});

test('history initialization reports lock contention instead of exposing an empty cache', () => {
  const directory = path.join(root, 'locked-startup');
  const storage = new ToolHistoryStorage(path.join(directory, 'data', 'agent'));
  const moduleUrl = pathToFileURL(path.resolve('packages/agent/dist/composition.js')).href;
  storage.withLock(() => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(moduleUrl)}); m.configureAgentServices();`], {
      env: { ...process.env, BRC_DATA_ROOT: directory },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /lock|ELOCKED/i);
  });
});

test('history writes preserve the destination of a symbolic link', async (t) => {
  const directory = path.join(root, 'linked');
  await mkdir(directory);
  const target = path.join(directory, 'target.jsonl');
  const link = path.join(directory, 'tool-history.json');
  await writeFile(target, '[{"n":1}]');
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('symbolic links require permission');
    throw error;
  }
  const storage = new ToolHistoryStorage(directory);
  storage.withLock(() => storage.appendText('{"n":2}\n'));
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), '[{"n":1},{"n":2}]');
});

test('rewrites do not widen existing POSIX permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode is not a Windows ACL');
  const storage = new ToolHistoryStorage(path.join(root, 'permissions'));
  storage.withLock(() => storage.rewriteText('first\n'));
  await chmod(storage.file, 0o600);
  storage.withLock(() => storage.appendText('second\n'));
  assert.equal((await stat(storage.file)).mode & 0o777, 0o600);
});

test('Windows DACL deny-write remains enforced across history rewrite', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-history-dacl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new ToolHistoryStorage(directory);
  storage.withLock(() => storage.rewriteText('original\n'));
  const user = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true });
  assert.equal(user.status, 0, user.stderr);
  const sid = '*' + user.stdout.trim();
  assert.match(sid, /^\*S-1-/);
  const acl = (args) => spawnSync('icacls.exe', [storage.file, ...args], { encoding: 'utf8', windowsHide: true });
  const denied = acl(['/deny', `${sid}:(W)`]);
  assert.equal(denied.status, 0, denied.stderr);
  try {
    assert.throws(() => storage.withLock(() => storage.rewriteText('changed\n')), (error) => ['EACCES','EPERM'].includes(error?.code));
  } finally {
    const restored = acl(['/remove:d', sid]);
    assert.equal(restored.status, 0, restored.stderr);
  }
  assert.equal(storage.readText(), 'original\n');
  storage.withLock(() => storage.rewriteText('updated\n'));
  assert.equal(storage.readText(), 'updated\n');
});

test('lock cleanup removes dead writers temporary files without following links', async (t) => {
  const directory = path.join(root, 'abandoned');
  const storage = new ToolHistoryStorage(directory);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const deadPid = Number(child.stdout);
  const suffix = '11111111-1111-4111-8111-111111111111.tmp';
  const abandoned = `${storage.file}.${deadPid}.${suffix}`;
  const live = `${storage.file}.${process.pid}.${suffix}`;
  const unrelated = path.join(directory, 'unrelated.tmp');
  await writeFile(abandoned, 'private history');
  await writeFile(live, 'live writer');
  await writeFile(unrelated, 'unrelated');
  const linked = `${storage.file}.${deadPid}.22222222-2222-4222-8222-222222222222.tmp`;
  let linkedCreated = false;
  try {
    await symlink(unrelated, linked, 'file');
    linkedCreated = true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('symbolic-link check skipped: permission unavailable');
  }
  storage.withLock(() => {});
  await assert.rejects(lstat(abandoned), { code: 'ENOENT' });
  assert.equal(await readFile(live, 'utf8'), 'live writer');
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated');
  if (linkedCreated) assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test('existing filesystem root does not require recursive mkdir', () => {
  const directory = path.parse(root).root;
  const storage = new ToolHistoryStorage(directory);
  assert.equal(storage.file, path.join(directory, 'tool-history.json'));
});

test('partial temporary write leaves committed history intact and can be retried', () => {
  const storage = new ToolHistoryStorage(path.join(root, 'partial'));
  storage.withLock(() => storage.rewriteText('{"n":1}\n'));
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = (name, data, options) => {
      if (String(name).endsWith('.tmp')) {
        original(name, String(data).slice(0, 4), options);
        throw new Error('simulated partial write');
      }
      return original(name, data, options);
    };
    syncBuiltinESMExports();
    assert.throws(() => storage.withLock(() => storage.appendText('{"n":2}\n')), /simulated partial write/);
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(storage.readText(), '{"n":1}\n');
  storage.withLock(() => storage.appendText('{"n":2}\n'));
  assert.equal(storage.readText(), '{"n":1}\n{"n":2}\n');
});

test('another process appends after compaction without losing its record', async () => {
  const directory = path.join(root, 'concurrent');
  const storage = new ToolHistoryStorage(directory);
  storage.withLock(() => storage.rewriteText('old\nkeep\n'));
  const moduleUrl = pathToFileURL(path.resolve('packages/agent/dist/adapters/telemetry/toolHistoryStorage.js')).href;
  const compact = `
    import { ToolHistoryStorage } from ${JSON.stringify(moduleUrl)};
    const storage = new ToolHistoryStorage(process.argv[1]);
    storage.withLock(() => {
      const text = storage.readText();
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      storage.rewriteText(text.split('\\n').slice(1).join('\\n'));
    });`;
  const append = `
    import { ToolHistoryStorage } from ${JSON.stringify(moduleUrl)};
    const storage = new ToolHistoryStorage(process.argv[1]);
    storage.withLock(() => storage.appendText('new\\n'));`;
  const first = spawn(process.execPath, ['--input-type=module', '-e', compact, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(first.stdout, 'data');
  const second = spawn(process.execPath, ['--input-type=module', '-e', append, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [firstExit, secondExit] = await Promise.all([once(first, 'exit'), once(second, 'exit')]);
  assert.equal(firstExit[0], 0);
  assert.equal(secondExit[0], 0);
  assert.equal(storage.readText(), 'keep\nnew\n');
});

test.after(async () => {
  await toolHistory.cleanup();
  await rm(root, { recursive: true, force: true });
});

test('history store persists a valid JSON document at the canonical agent data path', (t) => {
  const directory = path.join(root, 'json-format');
  const storage = new ToolHistoryStorage(directory);
  storage.withLock(() => storage.appendText('{"toolName":"sample","arguments":{},"output":{"content":[]}}\n'));
  assert.equal(path.basename(storage.file), 'tool-history.json');
  const parsed = JSON.parse(fs.readFileSync(storage.file, 'utf8'));
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].toolName, 'sample');
});

test('dispatcher exposes successful and failed calls without private content', async () => {
  const { callTool } = await import('../packages/agent/dist/adapters/mcp/dispatcher.js');
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
  assert.doesNotMatch(await readFile(file, 'utf8'), /history-dispatch-private-content/);
});

test('history failures do not alter dispatcher results', async () => {
  const { callTool } = await import('../packages/agent/dist/adapters/mcp/dispatcher.js');
  const original = toolHistory.addCall;
  toolHistory.addCall = () => { throw new Error('history unavailable'); };
  try {
    const result = await callTool('list_searches', {});
    assert.notEqual(result.isError, true);
  } finally {
    toolHistory.addCall = original;
  }
});

test('startup recovers a legacy file left after an interrupted migration', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-history-recover-'));
  const previous = process.env.BRC_DATA_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRC_DATA_ROOT;
    else process.env.BRC_DATA_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.BRC_DATA_ROOT = directory;
  const destination = path.join(directory, 'data', 'agent');
  await mkdir(destination, { recursive: true });
  const record = {
    timestamp: '2026-01-01T00:00:00.000Z', toolName: 'read_file',
    arguments: { path: 'recover-private-path' },
    output: { content: [{ type: 'text', text: 'recover-private-data' }] },
  };
  await writeFile(path.join(destination, 'tool-history.json'), JSON.stringify([record]));
  const legacy = path.join(destination, 'tool-history.jsonl');
  await writeFile(legacy, JSON.stringify(record) + '\n');
  const { ToolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
  const independent = new ToolHistory();
  t.after(() => independent.cleanup());
  assert.equal(independent.getRecentCalls({ maxResults: 10 }).length, 1);
  assert.doesNotMatch(await readFile(path.join(destination, 'tool-history.json'), 'utf8'), /recover-private/);
  await assert.rejects(readFile(legacy, 'utf8'), { code: 'ENOENT' });
});

test('failed migration retains the original legacy history for recovery', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-history-failed-migration-'));
  const previous = process.env.BRC_DATA_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRC_DATA_ROOT;
    else process.env.BRC_DATA_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.BRC_DATA_ROOT = directory;
  const destination = path.join(directory, 'data', 'agent');
  await mkdir(destination, { recursive: true });
  const legacy = path.join(destination, 'tool-history.jsonl');
  const source = JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z', toolName: 'read_file',
    arguments: { path: 'recoverable-private-path' }, output,
  }) + '\n';
  await writeFile(legacy, source);
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); };
  syncBuiltinESMExports();
  try {
    const { ToolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
    assert.throws(() => new ToolHistory(), /disk failure/);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(legacy, 'utf8'), source);
});

test('startup rewrites existing history without sensitive fields', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-history-sanitize-'));
  const previous = process.env.BRC_DATA_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRC_DATA_ROOT;
    else process.env.BRC_DATA_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.BRC_DATA_ROOT = directory;
  const destination = path.join(directory, 'data', 'agent');
  await mkdir(destination, { recursive: true });
  const canonical = path.join(destination, 'tool-history.json');
  await writeFile(canonical, JSON.stringify([{
    timestamp: '2026-01-01T00:00:00.000Z', toolName: 'read_file',
    arguments: { path: 'old-private-argument' },
    output: { content: [{ type: 'text', text: 'old-private-output' }], isError: true },
    extra: 'old-private-extra',
  }]));
  const { ToolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
  const independent = new ToolHistory();
  t.after(() => independent.cleanup());
  const stored = await readFile(canonical, 'utf8');
  assert.doesNotMatch(stored, /old-private-/);
  const records = independent.getRecentCalls({ maxResults: 10 });
  assert.equal(records[0].toolName, 'read_file');
  assert.equal(records[0].output.isError, true);
});

test('existing JSONL history migrates into a private JSON record collection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brc-history-legacy-'));
  const previous = process.env.BRC_DATA_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRC_DATA_ROOT;
    else process.env.BRC_DATA_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.BRC_DATA_ROOT = directory;
  const destination = path.join(directory, 'data', 'agent');
  await mkdir(destination, { recursive: true });
  const legacy = path.join(destination, 'tool-history.jsonl');
  await writeFile(legacy, JSON.stringify({
    timestamp: new Date().toISOString(), toolName: 'read_file',
    arguments: { path: 'private-record-path' },
    output: { content: [{ type: 'text', text: 'private-record-data' }] },
  }) + '\n');
  const { ToolHistory } = await import('../packages/agent/dist/adapters/telemetry/toolHistory.js');
  const independent = new ToolHistory();
  t.after(() => independent.cleanup());
  const records = independent.getRecentCalls({ maxResults: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].toolName, 'read_file');
  const stored = await readFile(path.join(destination, 'tool-history.json'), 'utf8');
  assert.equal(Array.isArray(JSON.parse(stored)), true);
  assert.doesNotMatch(stored, /private-record-/);
  await assert.rejects(readFile(legacy, 'utf8'), { code: 'ENOENT' });
});
