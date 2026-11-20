import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = path.resolve(import.meta.dirname, '..');
const systemInfoUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/system/system-info.js')).href;
const storageUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/telemetry/toolHistoryStorage.js')).href;
const filesystemUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/filesystem/filesystem.js')).href;
const toolDefinitionsUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/mcp/tool-definitions.js')).href;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brc-task5-'));
test.after(() => fsp.rm(root, { recursive: true, force: true }));

test('system info is computed once and reused until invalidated', async () => {
  const mod = await import(systemInfoUrl);
  assert.equal(typeof mod.clearSystemInfoCache, 'function');
  mod.clearSystemInfoCache();
  const first = mod.getSystemInfo();
  const second = mod.getSystemInfo();
  assert.strictEqual(first, second);
  mod.clearSystemInfoCache();
  assert.notStrictEqual(mod.getSystemInfo(), first);
});

test('importing tool definitions does not start Python probes', () => {
  const result = spawnSync(process.execPath, [
    '--require', path.join(pkgDir, 'test/fixtures/exec-probe.cjs'),
    '--input-type=module',
    '-e', `await import(${JSON.stringify(toolDefinitionsUrl)}); process.stdout.write('IMPORT_OK');`,
  ], { cwd: pkgDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /IMPORT_OK/);
  assert.doesNotMatch(result.stderr, /PYTHON_PROBE/);
});

test('history append writes incrementally without reading the whole file', async () => {
  const { ToolHistoryStorage } = await import(storageUrl);
  const directory = path.join(root, 'storage');
  const storage = new ToolHistoryStorage(directory);
  storage.withLock(() => storage.rewriteText('{"n":1}\n{"n":2}\n'));
  assert.equal(typeof storage.appendLinesIncrementally, 'function');

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function readFileSync(...args) {
    reads += 1;
    return original.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    storage.withLock(() => storage.appendLinesIncrementally('{"n":3}\n{"n":4}\n'));
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(reads, 0);
  const persisted = JSON.parse(await fsp.readFile(storage.file, 'utf8'));
  assert.deepEqual(persisted.map((record) => record.n), [1, 2, 3, 4]);
});

test('path validation exposes cache invalidation and reuses resolved paths', async () => {
  const filesystem = await import(filesystemUrl);
  assert.equal(typeof filesystem.invalidateRealpathCache, 'function');
  filesystem.invalidateRealpathCache();
  const directory = path.join(root, 'paths');
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'file.txt');
  await fsp.writeFile(file, 'x');
  const deps = {
    configManager: { getConfig: async () => ({ allowedDirectories: [directory] }) },
    capture: () => Promise.resolve(),
  };

  const original = fsp.realpath;
  let calls = 0;
  fsp.realpath = async function realpath(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    const first = await filesystem.validatePath(deps, file);
    const afterFirst = calls;
    assert.ok(afterFirst > 0);
    const second = await filesystem.validatePath(deps, file);
    assert.equal(second, first);
    assert.equal(calls, afterFirst);
    filesystem.invalidateRealpathCache();
    await filesystem.validatePath(deps, file);
    assert.ok(calls > afterFirst);
  } finally {
    fsp.realpath = original;
    syncBuiltinESMExports();
  }
});

test('history append preserves records containing multibyte characters', async () => {
  const { ToolHistoryStorage } = await import(storageUrl);
  const directory = path.join(root, 'storage-multibyte');
  const storage = new ToolHistoryStorage(directory);
  const chinese = '\u4e2d'.repeat(100);
  const emoji = '\u{1F600}'.repeat(20);
  storage.withLock(() => storage.rewriteText([
    JSON.stringify({ n: 1, v: chinese }),
    JSON.stringify({ n: 2, v: emoji }),
  ].join('\n')));

  storage.withLock(() => storage.appendLinesIncrementally(JSON.stringify({ n: 3, v: 'new' }) + '\n'));

  const persisted = JSON.parse(await fsp.readFile(storage.file, 'utf8'));
  assert.deepEqual(persisted.map((record) => record.n), [1, 2, 3]);
  assert.equal(persisted[0].v, chinese);
  assert.equal(persisted[1].v, emoji);
  assert.equal(persisted[2].v, 'new');
});

test('corrupt history returns null without throwing', async () => {
  const { ToolHistoryStorage } = await import(storageUrl);
  const directory = path.join(root, 'storage-corrupt');
  const storage = new ToolHistoryStorage(directory);
  await fsp.writeFile(storage.file, '[{"n":1},');
  assert.equal(storage.readText(), null);
});
