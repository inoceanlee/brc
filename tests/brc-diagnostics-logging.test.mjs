import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendTraceSummary } from '../packages/shared/dist/diagnostics/adapters/logging.js';

test('diagnostic JSONL is parseable after concurrent CLI writers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diag-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'cli.log');
  const entry = new URL('../packages/shared/dist/diagnostics/adapters/logging.js', import.meta.url).href;
  const tasks = Array.from({ length: 5 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendTraceSummary } from '${entry}';
    for(let i=0;i<12;i++) await appendTraceSummary(${JSON.stringify(log)}, {
      traceSchema:1,runId:'run-${index}-'+i,command:'start',startedAt:'2026-11-15T00:00:00Z',
      status:'ok',durationMs:1,accountedMs:1,unaccountedMs:0,stages:[]
    });
  `], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  }));
  await Promise.all(tasks);
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 60);
  assert.equal(new Set(lines.map((event) => event.runId)).size, 60);
});

test('oversized diagnostic events cannot truncate JSON or leak arbitrary fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diag-bounded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'cli.log');
  await appendTraceSummary(log, {
    traceSchema:1,runId:'run',command:'start',startedAt:new Date().toISOString(),
    status:'failed',durationMs:10,accountedMs:4,unaccountedMs:6,
    errorCode:'RUNTIME_ERROR', stages:Array.from({length:50},(_,i)=>({stage:'long'.repeat(500)+i,status:'failed',startMs:0,durationMs:1})),
    token:'must-not-appear',
  }, {maxRecordBytes:512});
  const line = await readFile(log, 'utf8');
  assert.doesNotMatch(line,/must-not-appear/);
  assert.equal(line.trim().split('\n').length, 1);
  assert.equal(JSON.parse(line).truncated, true);
  assert.ok(Buffer.byteLength(line) <= 512);
});

test('structured events redact secrets, prompts and diffs and keep stacks only on errors', async () => {
  const { createDiagnosticEvent } = await import('../packages/shared/dist/diagnostics/core/event.js');
  const event = createDiagnosticEvent({
    level: 'error',
    component: 'agent',
    source: { file: 'fuzzySearchLogger.ts', function: 'log' },
    message: 'fuzzy search failed',
    errorCode: 'search failed',
    stack: 'Error: boom\n    at log (fuzzySearchLogger.ts:1:1)',
    data: { token: 'abc', password: 'secret', diff: '---- a\n++++ b', content: 'private text', query: 'secret query', keep: 'visible' },
    now: new Date('2026-11-15T00:00:00Z'),
  });
  assert.equal(event.schema, 1);
  assert.equal(event.errorCode, 'SEARCH_FAILED');
  assert.match(event.stack, /boom/);
  assert.equal(event.data.token, '[redacted]');
  assert.equal(event.data.password, '[redacted]');
  assert.equal(event.data.diff, '[redacted]');
  assert.equal(event.data.content, '[redacted]');
  assert.equal(event.data.query, '[redacted]');
  assert.equal(event.data.keep, 'visible');
  const info = createDiagnosticEvent({
    level: 'info', component: 'cli', source: { file: 'cli.ts' }, message: 'ok',
    stack: 'Error: boom',
  });
  assert.equal(info.stack, undefined);
});

test('diagnostic event lines stay valid JSON when bounded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diag-event-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'cli.log');
  const { appendDiagnosticEvent } = await import('../packages/shared/dist/diagnostics/adapters/logging.js');
  await appendDiagnosticEvent(log, {
    level: 'warn', component: 'cli', source: { file: 'cli.ts' }, message: 'x'.repeat(5000),
    data: { detail: 'y'.repeat(5000) },
  }, { maxRecordBytes: 1_024 });
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) <= 1_024);
  assert.equal(JSON.parse(lines[0]).truncated, true);
});

test('diagnostic JSONL never reads implicit rotation environment settings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-diag-explicit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.BRC_LOG_ROTATE_MIB;
  process.env.BRC_LOG_ROTATE_MIB = 'invalid';
  try {
    const { appendDiagnosticEvent } = await import('../packages/shared/dist/diagnostics/adapters/logging.js');
    const filename = path.join(root, 'cli.log');
    await appendDiagnosticEvent(filename, {
      level: 'info', component: 'cli', source: { file: 'cli.ts' }, message: 'ready',
    });
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).message, 'ready');
  } finally {
    if (previous === undefined) delete process.env.BRC_LOG_ROTATE_MIB;
    else process.env.BRC_LOG_ROTATE_MIB = previous;
  }
});
