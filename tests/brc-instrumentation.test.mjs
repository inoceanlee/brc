import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

const EXCLUDED = ['/node_modules/', '/dist/', '/diagnostics/core/functions.ts', '/diagnostics/runtime.ts', '/diagnostics/adapters/logging.ts'];

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

function countFunctions(files, root) {
  let functions = 0;
  let generators = 0;
  for (const file of files) {
    const normalized = file.split(path.sep).join('/');
    if (EXCLUDED.some((pattern) => normalized.includes(pattern))) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        if (node.body) functions += 1;
        if (node.body && node.asteriskToken) generators += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { functions, generators, root };
}

test('build manifests cover every own TypeScript function', async () => {
  for (const pkg of ['shared', 'cli', 'relay', 'agent']) {
    const directory = path.resolve('packages', pkg);
    const manifest = JSON.parse(await readFile(path.join(directory, 'dist', 'diagnostics-manifest.json'), 'utf8'));
    const counted = countFunctions(await sources(path.join(directory, 'src')), directory);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.instrumented, counted.functions,
      `${pkg}: manifest must cover all instrumentable functions`);
    assert.equal(manifest.skipped.some((entry) => entry.reason === 'generator'), false,
      `${pkg}: generators must be instrumented`);
    assert.ok(counted.generators <= manifest.instrumented, `${pkg}: generator functions must be included`);
    const ids = manifest.functions.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `${pkg}: function ids must be unique`);
    for (const entry of manifest.functions) {
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.file, 'string');
      assert.ok(Number.isInteger(entry.line) && entry.line > 0);
      assert.ok(entry.kind === 'sync' || entry.kind === 'async');
    }
  }
});

test('instrumented output keeps the probe call shape and never touches probe internals', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('packages/cli/dist/diagnostics-manifest.json'), 'utf8'));
  const sample = manifest.functions.find((entry) => entry.name === 'runCli');
  assert.ok(sample, 'runCli must be instrumented');
  const compiled = await readFile(path.resolve('packages/cli/dist/cli.js'), 'utf8');
  assert.match(compiled, /__brcDiagBegin\?\.\(/);
  assert.match(compiled, /__brcDiagEnd\?\.\(/);
  const probeSource = await readFile(path.resolve('packages/shared/dist/diagnostics/core/functions.js'), 'utf8');
  assert.doesNotMatch(probeSource, /const __brcDiag\d+ = globalThis\.__brcDiagBegin/,
    'the probe implementation must not instrument itself');
});

test('async instrumentation measures settlement while preserving catch boundaries and receiver', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'async-fixture' });
  const source = [
    'export async function delayed() { return new Promise(resolve => setTimeout(() => resolve(42), 45)); }',
    "export async function uncaught() { try { return Promise.reject(new Error('expected')); } catch { return 'incorrect'; } }",
    'export class Receiver { constructor(value) { this.value = value; } async read() { return Promise.resolve(this.value); } }',
  ].join('\n');
  const output = ts.transpileModule(source, {
    fileName: path.join(process.cwd(), 'async-fixture.ts'),
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    assert.equal(await code.delayed(), 42);
    await assert.rejects(code.uncaught(), /expected/);
    assert.equal(await new code.Receiver(19).read(), 19);
    const expected = instrumenter.report().functions.find((value) => value.name === 'delayed');
    const delayed = timing.snapshot().entries.find((value) => value.id === expected.id);
    assert.ok(delayed && delayed.asyncWallMs >= 30, 'Promise settlement must determine async duration');
    assert.equal(delayed.calls, 1);
  } finally {
    probe.uninstall();
  }
});
