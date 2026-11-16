import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from '../packages/relay/node_modules/express/index.js';
import { SqliteStore, randomToken, sha256, verifyPassword } from '../packages/relay/dist/adapters/storage/sqlite.js';
import { RelayClientsStore, RelayOAuthProvider } from '../packages/relay/dist/adapters/http/oauth-provider.js';
import { HmacSessionSigner, Sessions } from '../packages/relay/dist/adapters/http/sessions.js';
import { SessionPolicy } from '../packages/relay/dist/core/auth/sessions.js';
import { LoginLimiter } from '../packages/relay/dist/core/auth/rate-limit.js';
import { DeviceHub } from '../packages/relay/dist/adapters/transport/device-hub.js';
import { mountRelayRoutes } from '../packages/relay/dist/adapters/http/app.js';
import { loadConfig } from '../packages/relay/dist/adapters/http/config.js';

test('HTTP OAuth metadata, authentication and isolated device pairing routes', async () => {
  const app = express();
  const http = createServer(app);
  const store = SqliteStore.open(':memory:');
  const hub = new DeviceHub('test', () => {});
  try {
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    const base = `http://127.0.0.1:${address.port}`;
    const cfg = loadConfig({ PORT: String(address.port), PUBLIC_URL: base, BRC_DB: ':memory:' });
    const user = store.upsertUser('admin', 'correct');
    const tokens = { randomToken, sha256 };
    const provider = new RelayOAuthProvider({
      store, tokens, issuer: base, currentUserId: () => null,
      renderLogin: () => {}, renderConsent: () => {},
    }, new RelayClientsStore(store, tokens));
    mountRelayRoutes({
      app, cfg, store, hub, provider, limiter: new LoginLimiter(), verifyPassword,
      sessions: new Sessions(new SessionPolicy(new HmacSessionSigner('secret')), false),
      log: () => {},
    });
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).devices, 0);
    const metadata = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, base);
    assert.equal((await fetch(base + '/mcp')).status, 401);
    const begin = await fetch(base + '/device/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-agent' }),
    });
    assert.equal(begin.status, 200);
    const challenge = await begin.json();
    const poll = () => fetch(base + '/device/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: challenge.device_code, device_id: 'test-device' }),
    });
    assert.equal((await (await poll()).json()).error, 'authorization_pending');
    const login = await fetch(base + '/auth/login', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'correct', returnTo: '/' }),
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const approve = await fetch(base + '/device/approve', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ user_code: challenge.user_code, decision: 'allow' }),
    });
    assert.equal(approve.status, 200);
    const paired = await (await poll()).json();
    assert.equal(paired.device_id, 'test-device');
    assert.ok(paired.device_token);
    assert.equal(store.getDevice('test-device').user_id, user.id);
  } finally {
    hub.close();
    await new Promise((resolve) => http.close(resolve));
    store.close();
  }
});
