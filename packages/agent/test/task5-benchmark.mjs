import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = path.resolve(import.meta.dirname, '..');
const toolDefinitionsUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/mcp/tool-definitions.js')).href;
const systemInfoUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/system/system-info.js')).href;
const storageUrl = pathToFileURL(path.join(pkgDir, 'dist/adapters/telemetry/toolHistoryStorage.js')).href;

const importChild = spawnSync(process.execPath, ['--input-type=module', '-e', `
const started = performance.now();
await import(${JSON.stringify(toolDefinitionsUrl)});
process.stdout.write(String(performance.now() - started));
`], { cwd: pkgDir, encoding: 'utf8' });
if (importChild.status !== 0) throw new Error(importChild.stderr);
console.log(`tool-definitions import ms: ${Number(importChild.stdout).toFixed(1)}`);

const systemInfo = await import(systemInfoUrl);
if (typeof systemInfo.clearSystemInfoCache === 'function') systemInfo.clearSystemInfoCache();
systemInfo.getSystemInfo();
let started = performance.now();
for (let index = 0; index < 100; index += 1) systemInfo.getSystemInfo();
console.log(`100x getSystemInfo ms: ${(performance.now() - started).toFixed(1)}`);

const { ToolHistoryStorage } = await import(storageUrl);
const root = await mkdtemp(path.join(os.tmpdir(), 'brc-task5-bench-'));
try {
  const storage = new ToolHistoryStorage(root);
  const records = Array.from({ length: 7000 }, (_, index) => ({ n: index, value: 'x'.repeat(640) }));
  storage.withLock(() => storage.rewriteText(records.map((record) => JSON.stringify(record)).join('\n')));
  const bytes = (await readFile(storage.file)).length;
  const incremental = typeof storage.appendLinesIncrementally === 'function';
  const append = incremental
    ? (text) => storage.appendLinesIncrementally(text)
    : (text) => storage.appendText(text);
  started = performance.now();
  for (let index = 0; index < 20; index += 1) {
    storage.withLock(() => append(`${JSON.stringify({ n: index })}\n`));
  }
  const elapsed = performance.now() - started;
  console.log(`history file bytes: ${bytes}`);
  console.log(`append method: ${incremental ? 'incremental' : 'full-rewrite'}`);
  console.log(`20x history append ms: ${elapsed.toFixed(1)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
