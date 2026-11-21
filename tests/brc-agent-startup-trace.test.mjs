import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const binary = fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url));

async function waitForReady(ready, child, errors) {
  const deadline = Date.now() + 10000;
  while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(ready), `ready file missing: ${errors}`);
}

test('agent startup trace records stages and startup diagnosis reads it', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-startup-trace-'));
  const ready = path.join(root, 'ready.json');
  const databasePath = path.join(root, 'data', 'brc-diagnostics.sqlite');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_'))),
    DO_NOT_TRACK: '1', BRC_DATA_ROOT: root, BRC_CONTROL_READY_FILE: ready,
    BRC_CONTROL_TOKEN: 'instance-token', BRC_MANAGED_ID: 'agent-instance', BRC_MANAGED_SERVICE: 'agent',
    BRC_RELAY: 'http://127.0.0.1:1', BRC_DEVICE_ID: 'device', BRC_TOKEN: 'token',
    BRC_DIAGNOSTICS_ENABLED: 'true', BRC_DIAGNOSTICS_DB: databasePath,
  };
  const child = spawn(process.execPath, [binary, 'connect', '--no-browser'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitForReady(ready, child, errors);

  const { SqliteDiagnosticsStore } = await import('../packages/shared/dist/index.js');
  const store = new SqliteDiagnosticsStore({ databasePath });
  try {
    let traces = [];
    const deadline = Date.now() + 5000;
    while (traces.length === 0 && Date.now() < deadline) {
      traces = store.queryTraces({ commands: ['start'], limit: 10 }).filter((item) => item.runId?.startsWith('agent-'));
      if (traces.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(traces.length > 0, `agent startup trace missing: ${errors}`);
    const trace = traces[0];
    assert.equal(trace.traceSchema, 1);
    assert.equal(trace.command, 'start');
    assert.equal(trace.status, 'ok');
    const names = trace.stages.map((stage) => stage.stage);
    for (const stage of ['parse-arguments', 'configure-services', 'diagnostics-init', 'connection-ready']) {
      assert.ok(names.includes(stage), `${stage} missing from ${names.join(',')}`);
    }
    for (const stage of trace.stages) {
      assert.equal(stage.service, 'agent');
      assert.ok(Number.isFinite(stage.startMs) && stage.startMs >= 0);
      assert.ok(Number.isFinite(stage.durationMs) && stage.durationMs >= 0);
    }
    const { readLatestStartup, readLatestLifecycle } = await import('../packages/cli/dist/commands/diagnostics.js');
    const paths = { root, logs: path.join(root, 'logs') };
    const startup = await readLatestStartup(paths, store);
    assert.equal(startup.state, 'recorded');
    assert.equal(startup.summary.runId, trace.runId);
    const lifecycle = await readLatestLifecycle(paths, store);
    assert.equal(lifecycle.state, 'recorded');
    assert.equal(lifecycle.summary.runId, trace.runId);
  } finally {
    store.close();
  }
});

test('agent startup trace is not written when diagnostics are disabled', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-startup-trace-off-'));
  const ready = path.join(root, 'ready.json');
  const databasePath = path.join(root, 'data', 'brc-diagnostics.sqlite');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_'))),
    DO_NOT_TRACK: '1', BRC_DATA_ROOT: root, BRC_CONTROL_READY_FILE: ready,
    BRC_CONTROL_TOKEN: 'instance-token', BRC_MANAGED_ID: 'agent-instance', BRC_MANAGED_SERVICE: 'agent',
    BRC_RELAY: 'http://127.0.0.1:1', BRC_DEVICE_ID: 'device', BRC_TOKEN: 'token',
    BRC_DIAGNOSTICS_ENABLED: 'false', BRC_DIAGNOSTICS_DB: databasePath,
  };
  const child = spawn(process.execPath, [binary, 'connect', '--no-browser'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitForReady(ready, child, errors);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { SqliteDiagnosticsStore } = await import('../packages/shared/dist/index.js');
  const store = new SqliteDiagnosticsStore({ databasePath });
  try {
    assert.deepEqual(store.queryTraces({ commands: ['start'], limit: 10 }), []);
  } finally {
    store.close();
  }
});
