import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { appendRotatingLog } from '../packages/shared/dist/managed-log.js';

const logsEntry = fileURLToPath(new URL('../packages/cli/dist/adapters/storage/logs.js', import.meta.url));
const logsUrl = JSON.stringify(pathToFileURL(logsEntry).href);

function runProbe(body) {
  return import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [
    '--input-type=module', '-e', `import { showLogs } from ${logsUrl};\n${body}`,
  ], { encoding: 'utf8', windowsHide: true }));
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-logs-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, logs, paths: { root, logs } };
}

function parseResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('shows active and rotated logs for all services by default', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.logs, 'relay.log.1'), 'older relay line\n');
  await writeFile(path.join(fixture.logs, 'relay.log'), 'newer relay line\n');
  await writeFile(path.join(fixture.logs, 'agent.log'), 'agent line\n');
  await writeFile(path.join(fixture.logs, 'traefik.log'), 'traefik line\n');

  const result = parseResult(await runProbe(`
const output = [];
const errors = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, undefined, (value) => output.push(value), (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, output, errors }));
`));

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.length, 3);
  assert.match(result.output[0], /older relay line[\s\S]*newer relay line/);
  assert.match(result.output[1], /agent line/);
  assert.match(result.output[2], /traefik line/);
  assert.deepEqual(result.errors, []);
});

test('shows only the requested service log', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.logs, 'relay.log'), 'relay secret-free output\n');
  await writeFile(path.join(fixture.logs, 'agent.log'), 'other service\n');

  const result = parseResult(await runProbe(`
const output = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, 'relay', (value) => output.push(value), () => {});
console.log(JSON.stringify({ exitCode, output }));
`));

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.length, 1);
  assert.match(result.output[0], /relay secret-free output/);
  assert.doesNotMatch(result.output[0], /other service/);
});

test('returns failure and a clear error when requested log is missing', async (t) => {
  const fixture = await makeFixture(t);
  const result = parseResult(await runProbe(`
const errors = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, 'agent', () => {}, (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join('\n'), /agent.*log.*not found/i);
});

test('reports no service logs when data root does not exist', async (t) => {
  const fixture = await makeFixture(t);
  await rm(fixture.root, { recursive: true, force: true });
  const result = parseResult(await runProbe(`
const output = [];
const errors = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, undefined, (value) => output.push(value), (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, output, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors.join('\n'), /no service logs were found/i);
});

test('bounds output to the newest log bytes', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(path.join(fixture.logs, 'relay.log'), `${'x'.repeat(70 * 1024)}\nLATEST\n`);
  const result = parseResult(await runProbe(`
const output = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, 'relay', (value) => output.push(value), () => {});
console.log(JSON.stringify({ exitCode, output }));
`));

  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /LATEST/);
  assert.ok(Buffer.byteLength(result.output[0], 'utf8') <= 64 * 1024 + 256);
});

test('refuses a log symlink without reading its target', async (t) => {
  const fixture = await makeFixture(t);
  const outside = path.join(fixture.root, 'outside.log');
  await writeFile(outside, 'outside secret');
  try {
    await symlink(outside, path.join(fixture.logs, 'relay.log'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symlink creation is unavailable.');
    throw error;
  }

  const result = parseResult(await runProbe(`
const output = [];
const errors = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, 'relay', (value) => output.push(value), (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, output, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors.join('\n'), /link|regular file|unsafe/i);
});

test('refuses a log directory outside the BRC root', async (t) => {
  const fixture = await makeFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-logs-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'relay.log'), 'outside secret');
  const paths = { ...fixture.paths, logs: outside };

  const result = parseResult(await runProbe(`
const output = [];
const errors = [];
const exitCode = await showLogs(${JSON.stringify(paths)}, 'relay', (value) => output.push(value), (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, output, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors.join('\n'), /outside|unsafe/i);
});

test('refuses a log directory junction or symlink', async (t) => {
  const fixture = await makeFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'brc-logs-linked-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'relay.log'), 'outside secret');
  await rm(fixture.logs, { recursive: true });
  try {
    await symlink(outside, fixture.logs, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Link creation is unavailable.');
    throw error;
  }

  const result = parseResult(await runProbe(`
const output = [];
const errors = [];
const exitCode = await showLogs(${JSON.stringify(fixture.paths)}, 'relay', (value) => output.push(value), (value) => errors.push(value));
console.log(JSON.stringify({ exitCode, output, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.match(result.errors.join('\n'), /link|directory/i);
});

test('managed log rotation honors the supplied limit', async (t) => {
  const fixture = await makeFixture(t);
  const filename = path.join(fixture.logs, 'configured.log');
  await appendRotatingLog(filename, Buffer.alloc(1024 * 1024 + 5, 0x61), 1024 * 1024);
  assert.equal((await readFile(filename)).length, 1024 * 1024);
});
