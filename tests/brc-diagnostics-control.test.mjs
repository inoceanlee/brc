import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createManagedControlRequestListener, startManagedControlServer } from '../packages/shared/dist/adapters/control/managed-control.js';

test('injected managed control listener checks loopback auth and dispatches health and shutdown', async (t) => {
  const owner = {
    token: 'secret',
    detail: 'ready',
    stopped: 0,
    health() { return { state: 'running', detail: this.detail }; },
    async stop() { this.stopped += 1; },
    onStopError(error) { throw error; },
  };
  const listener = createManagedControlRequestListener(owner);
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const endpoint = 'http://127.0.0.1:' + address.port;
  const hidden = await fetch(endpoint + '/health');
  assert.equal(hidden.status, 404);
  const headers = { authorization: 'Bearer secret' };
  const health = await fetch(endpoint + '/health', { headers });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, state: 'running', detail: 'ready' });
  const first = await fetch(endpoint + '/shutdown', { method: 'POST', headers });
  const second = await fetch(endpoint + '/shutdown', { method: 'POST', headers });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.stopped, 1);
});

test('shutdown waits for the shared stop result and reports failure', async (t) => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = createServer(createManagedControlRequestListener({
    token: 'secret',
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: async () => { calls += 1; await gate; throw new Error('resource shutdown failed'); },
    onStopError: () => {},
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/shutdown`;
  const options = { method: 'POST', headers: { authorization: 'Bearer secret' } };
  const first = fetch(endpoint, options);
  const second = fetch(endpoint, options);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  for (const response of results) {
    assert.equal(response.status, 500);
    assert.match((await response.json()).error.message, /resource shutdown failed/);
  }
});

test('control close waits for the shutdown response', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let begin;
  let release;
  const entered = new Promise((resolve) => { begin = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'agent',
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: async () => { begin(); await gate; },
    onStopError: () => {},
  });
  const request = fetch(`http://127.0.0.1:${control.port}/shutdown`, {
    method: 'POST', headers: { authorization: 'Bearer secret' },
  });
  await entered;
  let closed = false;
  const closing = control.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  const response = await request;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  await closing;
  assert.equal(closed, true);
});

test('managed control closes stalled client connections during shutdown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer();
  const received = new Promise((resolve) => server.once('connection', (socket) => socket.once('data', resolve)));
  const control = await startManagedControlServer({
    server,
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'agent',
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => {},
    onStopError: (error) => { throw error; },
  });
  assert.ok(control);
  const client = connect(control.port, '127.0.0.1');
  client.on('error', () => {});
  t.after(() => client.destroy());
  await once(client, 'connect');
  client.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
  await received;
  const closed = await Promise.race([
    control.close().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  assert.equal(closed, true);
});

test('control server closes when a shutdown task never completes', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'relay',
    shutdownTimeoutMs: 50,
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => new Promise(() => {}),
    onStopError: (error) => report(error),
  });
  const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
    method: 'POST', headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(4000),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error.message, /did not finish/);
  assert.match((await reported).message, /did not finish/);
  await control.close();
});

test('control honors a configured shutdown deadline longer than three seconds', { timeout: 8000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-configured-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failures = [];
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'relay',
    shutdownTimeoutMs: 5000,
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => new Promise((resolve) => setTimeout(resolve, 3200)),
    onStopError: (error) => failures.push(error),
  });
  const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
    method: 'POST', headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(7000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  await control.close();
  assert.deepEqual(failures, []);
});

test('cleanup completing after the deadline cannot change shutdown failure to success', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-late-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const failures = [];
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'relay',
    shutdownTimeoutMs: 50,
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => gate,
    onStopError: (error) => failures.push(error),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
      method: 'POST', headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error.message, /deadline/);
    release();
    await control.close();
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /deadline/);
  } finally {
    release();
    await control.close().catch(() => {});
  }
});

test('late shutdown failure is reported safely without a second response', { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-late-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fail;
  const gate = new Promise((_, reject) => { fail = reject; });
  void gate.catch(() => {});
  const failures = [];
  const control = await startManagedControlServer({
    server: createServer(),
    token: 'secret',
    readyFile: path.join(root, 'ready.json'),
    id: 'test',
    service: 'relay',
    shutdownTimeoutMs: 50,
    health: () => ({ state: 'running', detail: 'ready' }),
    stop: () => gate,
    onStopError: (error) => failures.push(error.message),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/shutdown`, {
      method: 'POST', headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error.message, /deadline/);
    fail(new Error('private-late-cleanup-value'));
    await new Promise((resolve) => setImmediate(resolve));
    await control.close();
    assert.equal(failures.length, 2);
    assert.match(failures[1], /failed after the deadline/);
    assert.doesNotMatch(failures.join(' '), /private-late-cleanup-value/);
  } finally {
    fail(new Error('cleanup'));
    await control.close().catch(() => {});
  }
});
