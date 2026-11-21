import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

test('first failure samples carry error message and stack, bounded per function', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'stack-fixture' });
  const source = 'export function boom() { throw new Error("sample failure"); }';
  const output = ts.transpileModule(source, {
    fileName: process.cwd() + '/stack-fixture.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    assert.throws(() => code.boom(), /sample failure/);
    assert.throws(() => code.boom(), /sample failure/);

    const id = instrumenter.report().functions.find((value) => value.name === 'boom').id;
    const samples = timing.failureSamples();
    const sample = samples.find((value) => value.id === id);
    assert.ok(sample, 'failure sample must be captured');
    assert.match(sample.message, /sample failure/);
    assert.match(sample.stack, /sample failure/);
    assert.equal(samples.filter((value) => value.id === id).length, 1, 'one sample per function');
  } finally {
    probe.uninstall();
  }
});
