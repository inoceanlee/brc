import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('connect --allow-dir persists the policy in Shared YAML before connection', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-allow-dir-'));
  const state = path.join(root, 'data', 'agent');
  const allowed = path.join(root, 'allowed');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'device.json'), JSON.stringify({
    relayUrl: 'http://127.0.0.1:1', deviceId: 'local-id', deviceToken: 'private',
    name: 'test-agent', pairedAt: '2026-11-16',
  }));
  const binary = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  const child = spawn(process.execPath, [binary, 'connect', '--allow-dir', allowed, '--no-browser'], {
    env: { ...env, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'config', 'brc.yaml');
  const deadline = Date.now() + 5000;
  while (!existsSync(filename) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(filename), 'connect did not write policy: ' + output);
  const yaml = createRequire(import.meta.url)('js-yaml');
  assert.deepEqual(yaml.safeLoad(readFileSync(filename, 'utf8')).agent.allowedDirectories, [allowed]);
});
