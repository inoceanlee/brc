import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

test('failure samples redact tokens and credentials', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'redact-fixture' });
  const source = 'export function boom() { throw new Error("Bearer abc123 deviceToken=xyz789 password: hunter2 ok"); }';
  const output = ts.transpileModule(source, {
    fileName: process.cwd() + '/redact-fixture.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    assert.throws(() => code.boom());
    const id = instrumenter.report().functions.find((value) => value.name === 'boom').id;
    const sample = timing.failureSamples().find((value) => value.id === id);
    assert.ok(sample);
    assert.doesNotMatch(sample.message, /abc123|xyz789|hunter2/);
    assert.match(sample.message, /\[redacted\]/);
  } finally {
    probe.uninstall();
  }
});

test('recursive early calls count once for time like the main timing', () => {
  const timing = new FunctionTiming({ clock: () => 0 });
  const early = timing.constructor === FunctionTiming ? globalThis[Symbol.for('brc.diag.early')] : undefined;
  assert.ok(early, 'early buffer must exist');
  const outer = early.begin('rec', 'sync', 0);
  const inner = early.begin('rec', 'sync', 2);
  early.end(inner, false, 4);
  early.end(outer, false, 10);
  const probe = installFunctionProbe(timing, {});
  try {
    const entry = timing.snapshot().entries.find((value) => value.id === 'rec');
    assert.equal(entry.calls, 2);
    assert.equal(entry.totalMs, 10, 'only outer duration counts');
  } finally {
    probe.uninstall();
  }
});

