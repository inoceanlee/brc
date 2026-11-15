import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

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
        if (node.asteriskToken) generators += 1;
        else if (node.body) functions += 1;
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
    const generators = manifest.skipped.filter((entry) => entry.reason === 'generator');
    assert.equal(generators.length, counted.generators, `${pkg}: generator functions must be reported, not silently skipped`);
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
