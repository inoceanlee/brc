import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';

test('instrumented async code preserves return values, catch boundaries and receiver', async () => {
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
  const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
  const code = await import(entry);
  assert.equal(await code.delayed(), 42);
  await assert.rejects(code.uncaught(), /expected/);
  assert.equal(await new code.Receiver(19).read(), 19);
});
