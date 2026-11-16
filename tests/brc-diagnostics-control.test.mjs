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
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.stopped, 1);
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
