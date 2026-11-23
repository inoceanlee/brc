import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { collectAdministratorCredentials } from '../packages/cli/dist/commands/setup.js';
import { helpText, parseCommand } from '../packages/cli/dist/commands/parser.js';
import { runCli } from '../packages/cli/dist/cli.js';
import { cliFailure, renderCliResult } from '../packages/shared/dist/index.js';

const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const logsEntry = fileURLToPath(new URL('../packages/cli/dist/adapters/storage/logs.js', import.meta.url));
const logsUrl = JSON.stringify(pathToFileURL(logsEntry).href);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));

function invoke(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: root },
  });
}

function probe(body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
}

test('non-interactive setup names the missing password and the usage code', async () => {
  const prompt = {
    askUsername: () => { throw new Error('prompt must not run'); },
    askHiddenPassword: () => { throw new Error('prompt must not run'); },
  };
  await assert.rejects(
    collectAdministratorCredentials({}, false, prompt),
    (error) => error.exitCode === 2
      && /BRC_ADMIN_PASSWORD/.test(error.message)
      && /--no-input/.test(error.message),
  );
});

test('JSON errors use one error envelope with machine fields', () => {
  const stderr = [];
  const code = renderCliResult(
    cliFailure({ code: 'AUTH_REQUIRED', exitCode: 3, message: 'Login required.', run: 'brc setup', retryable: false }),
    { format: 'json' },
    { stdout: () => { throw new Error('stdout must stay empty on errors'); }, stderr: (value) => stderr.push(value) },
  );
  assert.equal(code, 3);
  const payload = JSON.parse(stderr.join(''));
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.equal(payload.error.code, 'AUTH_REQUIRED');
  assert.equal(payload.error.exit_code, 3);
  assert.equal(payload.error.message, 'Login required.');
  assert.equal(payload.error.run, 'brc setup');
  assert.equal(payload.error.retryable, false);
});

test('runtime failures suggest a diagnostic command instead of a fixed help command', async () => {
  const errors = [];
  const paths = { root: 'root', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', traefik: 'traefik', tmp: 'tmp' };
  const exitCode = await runCli(['start', '--json'], {
    paths,
    commands: { start: async () => { throw new Error('relay crashed'); } },
    clean: async () => {},
    write: () => {},
    writeError: (value) => errors.push(value),
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(errors.join('\n'));
  assert.ok(payload.error, 'error envelope is present');
  assert.equal(payload.error.code, 'RUNTIME_ERROR');
  assert.notEqual(payload.error.run, 'brc help');
  assert.match(payload.error.run, /diagnose/);
});

test('diagnose functions returns an empty set and exit zero in machine formats', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-empty-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = invoke(root, 'diagnose', 'functions', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.doesNotMatch(result.stderr, /No function statistics/);
});

test('logs with no matches exits zero', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-empty-logs-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = probe(`import { showLogs } from ${logsUrl};
const errors = [];
const exitCode = await showLogs(${JSON.stringify({ root, logs })}, 'agent', () => {}, (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, errors }));`);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.exitCode, 0);
  assert.match(payload.errors.join('\n'), /agent.*log.*not found/i);
});

test('short help lists commands and flags while full help keeps examples and docs', () => {
  assert.equal(parseCommand(['-h']).helpBrief, true);
  assert.equal(parseCommand(['--help']).helpBrief, false);
  assert.equal(parseCommand(['help']).helpBrief, false);
  const brief = helpText(undefined, true);
  assert.match(brief, /Commands:/);
  assert.match(brief, /Global flags:/);
  assert.doesNotMatch(brief, /Examples:/);
  assert.doesNotMatch(brief, /Docs:/);
  const full = helpText();
  assert.match(full, /Docs:/);
  const commandFull = helpText('start');
  assert.match(commandFull, /Examples:/);
  assert.match(commandFull, /Docs:/);
  const commandBrief = helpText('start', true);
  assert.doesNotMatch(commandBrief, /Examples:/);
  assert.doesNotMatch(commandBrief, /Docs:/);
});

test('full top-level help includes copy-pasteable examples', () => {
  const full = helpText();
  assert.match(full, /Examples:/);
  assert.match(full, /brc start/);
  assert.match(full, /brc status --json/);
  assert.match(full, /brc config show/);
  assert.doesNotMatch(helpText(undefined, true), /Examples:/);
});


test('unexpected crash reports version, platform, command and issue link without raw stack', () => {
  const notDirectory = fileURLToPath(new URL('../package.json', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'status'], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...cleanEnvironment, BRC_DATA_ROOT: notDirectory },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Crash:/);
  assert.match(result.stderr, /Version:/);
  assert.match(result.stderr, /Platform:/);
  assert.match(result.stderr, /status/);
  assert.match(result.stderr, /github\.com\/inoceanlee\/brc\/issues/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});
