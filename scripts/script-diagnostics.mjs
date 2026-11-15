import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createInstrumentation } from './instrument-functions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scriptsRoot = path.join(root, 'scripts');
const target = path.resolve(process.argv[2] ?? '');
if (!target.startsWith(scriptsRoot + path.sep) || !target.endsWith('.mjs')) {
  throw new Error('Script diagnostics requires a project script entrypoint.');
}
process.argv.splice(1, 2, target);

async function runWithDiagnostics() {
  const runtimePath = path.join(root, 'packages/shared/dist/diagnostics/runtime.js');
  if (!existsSync(runtimePath)) {
    await import(pathToFileURL(target).href);
    return;
  }
  const { startDiagnostics, resolveDiagnosticsSettings } = await import(pathToFileURL(runtimePath).href);
  const directory = process.env.BRC_DIAGNOSTICS_DIR ?? path.join(os.tmpdir(), 'brc-script-diagnostics');
  const env = {
    ...process.env,
    BRC_DIAGNOSTICS_DIR: directory,
    BRC_DIAGNOSTICS_ENABLED: process.env.BRC_DIAGNOSTICS_ENABLED ?? 'true',
  };
  const settings = resolveDiagnosticsSettings(env);
  const diagnostics = await startDiagnostics({
    component: 'cli', instanceId: 'script-' + process.pid + '-' + randomUUID(), env,
  });
  const tracked = new Map();
  if (diagnostics.enabled && diagnostics.functions) {
    registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!url.startsWith('file:')) return result;
        const file = fileURLToPath(url);
        if (!file.startsWith(scriptsRoot + path.sep) || !file.endsWith('.mjs')) return result;
        const instrumenter = createInstrumentation(ts, { rootDir: root, packageName: 'brc-scripts' });
        const output = ts.transpileModule(String(result.source), {
          fileName: file,
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          transformers: { before: [instrumenter.transformer] },
        });
        const report = instrumenter.report();
        for (const entry of report.functions) diagnostics.functions.register(entry.id, entry);
        tracked.set(file, { instrumented: report.instrumented, skipped: report.skipped });
        return { ...result, source: output.outputText };
      },
    });
  }
  try {
    await import(pathToFileURL(target).href);
  } finally {
    await diagnostics.stop();
    if (diagnostics.enabled) {
      await mkdir(directory, { recursive: true });
      const key = createHash('sha256').update(target).digest('hex').slice(0, 16);
      const destination = path.join(directory, 'coverage-' + key + '.json');
      const temporary = destination + '.' + process.pid + '.tmp';
      await writeFile(temporary, JSON.stringify({
        schema: 1, entrypoint: path.relative(root, target), modules: [...tracked],
      }) + '\n');
      await rename(temporary, destination);
      const retentionMs = settings.retentionDays * 86_400_000;
      const { FileSnapshotStore } = await import(pathToFileURL(
        path.join(root, 'packages/shared/dist/diagnostics/adapters/snapshots.js'),
      ).href);
      await new FileSnapshotStore({ directory }).prune(retentionMs, () => false);
      const now = Date.now();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^coverage-[0-9a-f]{16}\.json$/.test(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        const info = await stat(filename);
        if (now - info.mtimeMs > retentionMs) await unlink(filename);
      }
    }
  }
}

await runWithDiagnostics();
