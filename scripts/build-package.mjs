import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createInstrumentation } from './instrument-functions.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Compiles one workspace package with build-time function instrumentation and
 * writes the coverage manifest next to the emitted JavaScript. Type errors
 * abort the build exactly like plain `tsc -p`.
 */
export async function buildPackage(directory, options = {}) {
  const cwd = path.resolve(directory);
  const configPath = path.join(cwd, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, cwd, undefined, configPath);
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => cwd, getNewLine: () => '\n' };
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  }
  const manifestName = path.basename(cwd);
  const instrumentation = createInstrumentation(ts, {
    rootDir: cwd,
    packageName: JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')).name ?? manifestName,
    exclude: [
      '/node_modules/',
      '/dist/',
      // The probe implementation must never call itself.
      '/diagnostics/core/functions.ts',
      '/diagnostics/runtime.ts',
      '/diagnostics/adapters/logging.ts',
    ],
  });
  const emitted = program.emit(undefined, undefined, undefined, false, {
    before: [instrumentation.transformer],
  });
  if (emitted.emitSkipped) throw new Error('TypeScript emit was skipped.');
  const outDir = parsed.options.outDir ?? path.join(cwd, 'dist');
  await writeFile(path.join(outDir, 'diagnostics-manifest.json'), `${JSON.stringify(instrumentation.report(), null, 2)}\n`);
  return instrumentation.report();
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const report = await buildPackage(process.argv[2] ?? '.');
  console.log(`${report.package}: instrumented ${report.instrumented} functions in ${report.files} files.`);
}
