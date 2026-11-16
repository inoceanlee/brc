import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve(import.meta.dirname, '../packages/relay/dist/cli.js');

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('relay CLI isolated start, health, managed logs, diagnostic snapshot and shutdown', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brc-relay-runtime-'));
  const port = await availablePort();
  const env = { ...process.env };
  for (const name of ['BRC_CONTROL_TOKEN', 'BRC_CONTROL_READY_FILE', 'BRC_MANAGED_ID', 'BRC_MANAGED_SERVICE']) delete env[name];
  Object.assign(env, {
    BRC_DB: path.join(dir, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(dir, 'relay.log'),
    BRC_DIAGNOSTICS_ENABLED: 'true',
    BRC_DIAGNOSTICS_DIR: path.join(dir, 'diag'),
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    BRC_CONTROL_TOKEN: 'test-control-token',
    BRC_CONTROL_READY_FILE: path.join(dir, 'control.json'),
    BRC_MANAGED_ID: 'test-relay',
    BRC_MANAGED_SERVICE: 'relay',
  });
  let child;
  try {
    const init = spawnSync(process.execPath, [cli, '--initialize'], {
      env, input: JSON.stringify({ username: 'admin', password: 'safe-test-password' }),
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(init.status, 0, init.stderr);
    child = spawn(process.execPath, [cli], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Relay startup timed out: ' + stdout + stderr)), 10_000);
      child.on('exit', (code) => { clearTimeout(timeout); reject(new Error('Relay exited early ' + code + ': ' + stdout + stderr)); });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes('brc-relay listening')) { clearTimeout(timeout); resolve(); }
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    for (let attempt = 0; attempt < 40 && !existsSync(env.BRC_CONTROL_READY_FILE); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(env.BRC_CONTROL_READY_FILE), 'managed control ready file missing');
    const ready = JSON.parse(readFileSync(env.BRC_CONTROL_READY_FILE, 'utf8'));
    const shutdown = await fetch(`http://127.0.0.1:${ready.port}/shutdown`, {
      method: 'POST', headers: { authorization: 'Bearer ' + env.BRC_CONTROL_TOKEN },
    });
    assert.equal(shutdown.status, 202);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stdout + stderr);
    child = undefined;
    assert.match(readFileSync(path.join(dir, 'relay.log'), 'utf8'), /brc-relay listening/);
    const events = readFileSync(path.join(dir, 'relay-diagnostics.log'), 'utf8');
    assert.match(events, /brc-relay listening/);
    const snapshotFile = readdirSync(path.join(dir, 'diag')).find((name) => name.startsWith('relay-'));
    assert.ok(snapshotFile);
    const snapshot = JSON.parse(readFileSync(path.join(dir, 'diag', snapshotFile), 'utf8'));
    assert.equal(snapshot.status, 'exited');
    assert.equal(snapshot.service, 'relay');
    assert.ok(snapshot.resources);
    assert.ok(snapshot.functions.totalCalls > 0, 'Relay function timing must record calls');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
