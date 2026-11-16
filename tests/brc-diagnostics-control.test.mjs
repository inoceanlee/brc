import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createManagedControlRequestListener } from '../packages/shared/dist/adapters/control/managed-control.js';

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
