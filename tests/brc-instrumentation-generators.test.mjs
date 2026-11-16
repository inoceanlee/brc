import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';
import { createInstrumentation } from '../scripts/instrument-functions.mjs';
import { FunctionTiming, installFunctionProbe } from '../packages/shared/dist/diagnostics/core/functions.js';

async function loadInstrumented(source) {
  const instrumentation = createInstrumentation(ts, { rootDir: process.cwd(), packageName: 'generator-fixture' });
  const result = ts.transpileModule(source, {
    fileName: path.join(process.cwd(), 'generator-fixture.ts'),
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [instrumentation.transformer] },
  });
  const code = await import('data:text/javascript;base64,' + Buffer.from(result.outputText).toString('base64'));
  return { code, report: instrumentation.report() };
}

test('generator timing counts each resumed segment without idle time', async () => {
  const { code, report } = await loadInstrumented('export function* values() { const value = yield 3; yield* [value, 5]; return 7; }');
  const descriptor = report.functions.find((entry) => entry.name === 'values');
  assert.ok(descriptor, 'generator must appear in function coverage');
  assert.equal(report.skipped.some((entry) => entry.reason === 'generator'), false);
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const iterator = code.values();
    assert.deepEqual(iterator.next(), { value: 3, done: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(iterator.next(4), { value: 4, done: false });
    assert.deepEqual(iterator.next(), { value: 5, done: false });
    assert.deepEqual(iterator.next(), { value: 7, done: true });
    const record = timing.snapshot().entries.find((entry) => entry.id === descriptor.id);
    assert.ok(record, 'generator must record execution time');
    assert.equal(record.calls, 4);
    assert.ok(record.totalMs < 80, 'suspended time must not count as execution');
  } finally {
    probe.uninstall();
  }
});

test('generator instrumentation preserves super, receiver, throw, and return', async () => {
  const source = [
    'export class Parent { value() { return 8; } }',
    'export class Child extends Parent { constructor() { super(); this.tag = 13; } *read() { yield super.value(); return this.tag; } }',
    'export function* recover() { try { yield 1; } catch (error) { yield error.message; } }',
  ].join('\n');
  const { code, report } = await loadInstrumented(source);
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const child = new code.Child().read();
    assert.deepEqual(child.next(), { value: 8, done: false });
    assert.deepEqual(child.next(), { value: 13, done: true });
    const recovered = code.recover();
    assert.deepEqual(recovered.next(), { value: 1, done: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(recovered.throw(new Error('recovered')), { value: 'recovered', done: false });
    assert.deepEqual(recovered.return(31), { value: 31, done: true });
    const record = timing.snapshot().entries.find((entry) => entry.id === report.functions.find((item) => item.name === 'recover').id);
    assert.ok(record.totalMs < 80, 'throw and return must not count suspension');
    assert.equal(record.calls, 3);
  } finally {
    probe.uninstall();
  }
});

test('async generator timing excludes pauses between next calls', async () => {
  const { code, report } = await loadInstrumented('export async function* values() { yield Promise.resolve(3); yield 5; return 7; }');
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const iterator = code.values();
    assert.deepEqual(await iterator.next(), { value: 3, done: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(await iterator.next(), { value: 5, done: false });
    assert.deepEqual(await iterator.next(), { value: 7, done: true });
    const descriptor = report.functions.find((entry) => entry.name === 'values');
    assert.ok(descriptor);
    const record = timing.snapshot().entries.find((entry) => entry.id === descriptor.id);
    assert.equal(record.calls, 3);
    assert.ok(record.totalMs < 80, 'async generator must exclude caller wait');
  } finally {
    probe.uninstall();
  }
});

test('generator delegation keeps finally yields after early return', async () => {
  const source = 'export function* values() { try { yield* (function* inner() { yield 2; yield 3; })(); } finally { yield 9; } }';
  const { code, report } = await loadInstrumented(source);
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const iterator = code.values();
    assert.deepEqual(iterator.next(), { value: 2, done: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(iterator.return(6), { value: 9, done: false });
    assert.deepEqual(iterator.next(), { value: 6, done: true });
    const descriptor = report.functions.find((entry) => entry.name === 'values');
    const record = timing.snapshot().entries.find((entry) => entry.id === descriptor.id);
    assert.equal(record.calls, 3);
    assert.ok(record.totalMs < 80, 'delegated cleanup must exclude suspension');
  } finally {
    probe.uninstall();
  }
});

test('async yield delegation keeps values and excludes caller pauses', async () => {
  const source = 'export async function* values() { yield* (async function* inner() { yield Promise.resolve(4); yield 5; })(); }';
  const { code, report } = await loadInstrumented(source);
  const timing = new FunctionTiming();
  const probe = installFunctionProbe(timing);
  try {
    const iterator = code.values();
    assert.deepEqual(await iterator.next(), { value: 4, done: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(await iterator.next(), { value: 5, done: false });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    const descriptor = report.functions.find((entry) => entry.name === 'values');
    const record = timing.snapshot().entries.find((entry) => entry.id === descriptor.id);
    assert.equal(record.calls, 3);
    assert.ok(record.totalMs < 80);
  } finally {
    probe.uninstall();
  }
});
