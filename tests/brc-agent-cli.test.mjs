import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));
const credentials = { relayUrl: 'https://relay.example', deviceId: 'local', deviceToken: 'private-secret', name: 'local', pairedAt: '2026-01-01' };

function run(args, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-cli-'));
  const file = path.join(root, 'data', 'agent', 'device.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(credentials));
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  const result = spawnSync(process.execPath, [binary, ...args], {
    encoding: 'utf8', timeout: 5000, input: options.input ?? '',
    env: { ...base, CI: 'true', DO_NOT_TRACK: '1', BRC_DATA_ROOT: root, BRC_HOME: root, BRC_UPSTREAM_TELEMETRY: '0', ...options.env },
  });
  const present = existsSync(file);
  const stored = present ? JSON.parse(readFileSync(file, 'utf8')) : null;
  rmSync(root, { recursive: true, force: true });
  return { ...result, present, stored };
}

test('bare, help, and version commands are offline and return success', () => {
  for (const args of [[], ['help'], ['--help'], ['version']]) {
    const result = run(args);
    assert.equal(result.status, 0, String(result.stderr));
    assert.ok(result.stdout.trim());
    assert.doesNotMatch(result.stdout, /private-secret/);
  }
});

test('secret flags are rejected before connecting or logging', () => {
  const result = run(['connect', '--token', 'private-secret', '--json']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /private-secret/);
  assert.equal(JSON.parse(result.stderr).exit_code, 2);
  assert.equal(result.present, true);
});

test('logout without confirmation cannot remove saved credentials', () => {
  const result = run(['credentials', 'logout', '--no-input', '--json']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).exit_code, 2);
  assert.deepEqual(result.stored, credentials);
});

test('preview takes precedence over yes and does not remove credentials', () => {
  const result = run(['credentials', 'logout', '--yes', '--preview', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.present, true);
  assert.doesNotMatch(result.stdout, /private-secret/);
  assert.doesNotMatch(result.stderr, /private-secret/);
});

test('confirmed logout removes only Agent credentials', () => {
  const result = run(['credentials', 'logout', '--yes', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.present, false);
  assert.equal(JSON.parse(result.stdout).removed, true);
});

test('token stdin requires nonempty data and does not echo it on failure', () => {
  const result = run(['connect', '--relay', 'https://relay.example', '--device-id', 'local', '--token-stdin', '--json'], { input: '' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).exit_code, 2);
  assert.deepEqual(result.stored, credentials);
});


test('connect preview is offline and does not open a Relay connection', () => {
  const result = run(['connect', '--relay', 'https://relay.example', '--preview', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, false);
  assert.deepEqual(result.stored, credentials);
});

test('explicit --output json formats parser errors as JSON on stderr', () => {
  const result = run(['--output', 'json', 'connect', '--not-real']);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.exit_code, 2);
  assert.equal(error.code, 'INVALID_USAGE');
});
