import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

test('instrumented throwing function increments the error count', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'error-fixture' });
  const source = [
    'export function boom() { throw new Error("kaboom"); }',
    'export function safe() { return 1; }',
  ].join('\n');
  const output = ts.transpileModule(source, {
    fileName: process.cwd() + '/error-fixture.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });

  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    assert.throws(() => code.boom(), /kaboom/);
    assert.equal(code.safe(), 1);

    const report = instrumenter.report();
    const boomId = report.functions.find((value) => value.name === 'boom').id;
    const safeId = report.functions.find((value) => value.name === 'safe').id;
    const boom = timing.snapshot().entries.find((value) => value.id === boomId);
    const safe = timing.snapshot().entries.find((value) => value.id === safeId);
    assert.ok(boom, 'throwing function must be recorded');
    assert.equal(boom.errors, 1, 'failed call must increment error count');
    assert.equal(safe.errors, 0, 'successful call must not increment error count');
  } finally {
    probe.uninstall();
  }
});

test('instrumented throwing generator increments the error count', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'gen-error-fixture' });
  const source = 'export function* bad() { yield 1; throw new Error("genfail"); }';
  const output = ts.transpileModule(source, {
    fileName: process.cwd() + '/gen-error-fixture.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    const iterator = code.bad();
    assert.deepEqual(iterator.next(), { value: 1, done: false });
    assert.throws(() => iterator.next(), /genfail/);
    const failId = instrumenter.report().functions.find((value) => value.name === 'bad').id;
    const fail = timing.snapshot().entries.find((value) => value.id === failId);
    assert.ok(fail);
    assert.equal(fail.errors, 1, 'failed generator must increment error count');
  } finally {
    probe.uninstall();
  }
});

test('instrumented throwing async function increments the error count', async () => {
  const instrumenter = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'async-error-fixture' });
  const source = 'export async function fail() { throw new Error("nope"); }';
  const output = ts.transpileModule(source, {
    fileName: process.cwd() + '/async-error-fixture.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumenter.transformer] },
  });
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const entry = 'data:text/javascript;base64,' + Buffer.from(output.outputText).toString('base64');
    const code = await import(entry);
    await assert.rejects(code.fail(), /nope/);
    const failId = instrumenter.report().functions.find((value) => value.name === 'fail').id;
    const fail = timing.snapshot().entries.find((value) => value.id === failId);
    assert.ok(fail);
    assert.equal(fail.errors, 1, 'failed async call must increment error count');
  } finally {
    probe.uninstall();
  }
});
