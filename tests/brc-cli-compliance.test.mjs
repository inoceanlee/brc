import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseCommand } from '../packages/cli/dist/commands/parser.js';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';

const tempRoot = realpathSync.native(tmpdir());

function invoke(args) {
  const root = path.join(tmpdir(), 'brc-agent-b-cli-contract');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  return spawnSync(process.execPath, ['packages/cli/dist/cli.js', ...args], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
    env: { ...env, BRC_DATA_ROOT: root },
  });
}

test('bare brc is help-only without an uninitialized service error', () => {
  const result = invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC unified CLI/);
  assert.doesNotMatch(result.stderr, /not initialized/);
});
test('JSON errors use stderr only with stable machine fields', () => {
  const result = invoke(['unknown', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim()).error;
  for (const key of ['code', 'exit_code', 'message', 'run', 'retryable']) {
    assert.equal(key in error, true, key);
  }
});

test('output, flags and option terminator are parsed consistently', () => {
  const parsed = parseCommand(['-qv', '--output=json', 'status']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.quiet, false);
  assert.equal(parsed.verbose, true);
  assert.equal(parseCommand(['status', '-o', 'yaml']).output, 'yaml');
  assert.equal(parseCommand(['logs', '--', 'cli']).logComponent, 'cli');
});

test('ServiceManager requires injected process and lock adapters', () => {
  const paths = { root: 'root' };
  assert.throws(() => new ServiceManager(paths, []), /requires|inject|process/i);
});
test('help and version expose machine-readable data', () => {
  for (const command of ['help', 'version']) {
    const result = invoke([command, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test('shell completion is generated from the same command specification', () => {
  for (const shell of ['powershell', 'bash', 'zsh', 'fish']) {
    const result = invoke(['completion', shell]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /start/);
    assert.match(result.stdout, /diagnose/);
    assert.match(result.stdout, /completion/);
  }
});

test('clean returns JSON data without a human banner', () => {
  const result = invoke(['clean', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.command, 'clean');
  assert.equal(data.status, 'success');
});

test('config set preview shows concrete delta without writing a settings file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = invokeWithRoot(['config', 'set', 'proxy.concurrent', '45', '--preview'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proxy\.concurrent/);
  assert.match(result.stdout, /16/);
  assert.match(result.stdout, /45/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path.join(root, 'config', 'brc.yaml')), false);
});

function invokeWithRoot(args, root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  return spawnSync(process.execPath, ['packages/cli/dist/cli.js', ...args], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
    env: { ...env, BRC_DATA_ROOT: root },
  });
}

test('config set and logs JSON produce one structured result', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-output-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const changed = invokeWithRoot(['config', 'set', 'proxy.concurrent', '24', '--json'], root);
  assert.equal(changed.status, 0, changed.stderr);
  const updated = JSON.parse(changed.stdout);
  assert.equal(updated.key, 'proxy.concurrent');
  assert.equal(updated.value, 24);
  const logs = invokeWithRoot(['logs', 'cli', '--json'], root);
  assert.equal(logs.status, 0, logs.stderr);
  const logData = JSON.parse(logs.stdout);
  assert.equal(logData.component, 'cli');
  assert.equal(Array.isArray(logData.lines), true);
});

test('stop JSON emits one result and no human status line', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-stop-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = invokeWithRoot(['stop', '--json'], root);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.command, 'stop');
  assert.equal(data.status, 'success');
  assert.doesNotMatch(result.stdout, /services stopped\./);
});
test('unsupported preview never mutates local data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-no-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = invokeWithRoot(['clean', '--preview'], root);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /preview/i);
});

test('offline Traefik update fails before querying remote metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-no-network-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = invokeWithRoot(['update', 'traefik', '--offline', '--json'], root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim()).error;
  assert.match(error.message, /offline/i);
});

test('structured uninstall returns its outcome without writing human text', async (t) => {
  const { uninstallBrc } = await import('../packages/cli/dist/adapters/storage/uninstall.js');
  const root = await mkdtemp(path.join(tempRoot, 'brc-uninstall-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'].map((name) => [name, path.join(root, name)]));
  const writes = [];
  const result = await uninstallBrc({
    yes: true,
    structuredOutput: true,
    paths: { root, ...paths },
    confirm: async () => true,
    stopServices: async () => {},
    clean: async () => {},
    removePackage: async () => ({ scheduled: true, reportPath: 'isolated-report.json' }),
    write: (message) => writes.push(message),
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data, {
    command: 'uninstall',
    status: 'success',
    dataRemoved: true,
    packageRemoval: 'scheduled',
    reportPath: 'isolated-report.json',
    residuals: [],
  });
  assert.deepEqual(writes, []);
});

test('DO_NOT_TRACK is inherited by all managed child processes', async () => {
  const { createDefaultServices } = await import('../packages/cli/dist/adapters/process/specs.js');
  const { DEFAULT_SETTINGS } = await import('../packages/shared/dist/index.js');
  const root = path.join(tmpdir(), 'brc-no-telemetry');
  const paths = Object.fromEntries(['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'].map((name) => [name, path.join(root, name)]));
  const services = createDefaultServices({ root, ...paths }, DEFAULT_SETTINGS, { DO_NOT_TRACK: '1' });
  assert.equal(services.length, 3);
  assert.equal(services.every((service) => service.env.DO_NOT_TRACK === '1'), true);
});

test('offline update and unsupported write previews fail before side effects', () => {
  const offline = invoke(['update', 'traefik', '--offline', '--json']);
  assert.equal(offline.status, 2);
  assert.equal(offline.stdout, '');
  const offlineError = JSON.parse(offline.stderr.trim()).error;
  assert.match(offlineError.message, /--offline prevents remote queries|release lookup/i);

  const preview = invoke(['uninstall', '--confirm', 'root', '--yes', '--preview', '--json']);
  assert.equal(preview.status, 2);
  assert.equal(preview.stdout, '');
  const previewError = JSON.parse(preview.stderr.trim()).error;
  assert.match(previewError.message, /preview is unsupported/i);
});

test('top-level help documents the implemented global CLI contract', () => {
  const result = invoke(['help']);
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ['--output', '--timeout', '--offline', '--no-telemetry', '--preview', '--interactive', '--no-color', '--debug']) {
    assert.match(result.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
