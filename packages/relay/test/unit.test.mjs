// Unit tests for relay internals. Run after build: node --test packages/relay/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore, randomToken, sha256, verifyPassword, hashPassword } from '../dist/adapters/storage/sqlite.js';
import { RelayOAuthProvider, RelayClientsStore } from '../dist/adapters/http/oauth-provider.js';
import { LoginLimiter } from '../dist/core/auth/rate-limit.js';
import { DeviceHub } from '../dist/adapters/transport/device-hub.js';

test('password hashing round-trips and rejects wrong password', () => {
  const h = hashPassword('s3cret');
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('S3cret', h));
  assert.ok(!verifyPassword('s3cret', 'garbage'));
});

test('store: device token issue / lookup / revoke, pairing codes, audit', () => {
  const s = SqliteStore.open(':memory:');
  const u = s.upsertUser('admin', 'pw');
  const raw = s.issueDeviceToken('dev1', u.id, 'PC', 'win32');
  assert.equal(s.getDeviceByToken(raw)?.device_id, 'dev1');
  assert.equal(s.getDeviceByToken(raw + 'x'), undefined);
  const raw2 = s.issueDeviceToken('dev1', u.id, 'PC', 'win32');
  assert.equal(s.getDeviceByToken(raw), undefined, 're-issue invalidates old token');
  assert.equal(s.getDeviceByToken(raw2)?.device_id, 'dev1');
  s.deleteDevice('dev1');
  assert.equal(s.getDeviceByToken(raw2), undefined);

  const dc = s.createDeviceCode('agent', 60_000);
  assert.match(dc.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(s.getDeviceCodeByUserCode(dc.user_code.toLowerCase().replace('-', ''))?.device_code, dc.device_code, 'user code lookup is lenient');
  s.approveDeviceCode(dc.device_code, u.id, '');
  assert.equal(s.getDeviceCode(dc.device_code)?.approved, 1);

  s.audit({ ts: Date.now(), user_id: u.id, device_id: 'dev1', client: 'c', tool: 'read_file', args_hash: 'ab', ok: 1, ms: 5, error: null });
  s.audit({ ts: Date.now(), user_id: u.id, device_id: 'dev1', client: 'c', tool: 'read_file', args_hash: 'ab', ok: 0, ms: 5, error: 'x' });
  assert.deepEqual(s.auditStats(u.id), { total: 2, failed: 1, last24h: 2 });
  s.close();
});

test('store: tokens expire and revoke', () => {
  const s = SqliteStore.open(':memory:');
  const now = Date.now();
  const h = (t) => createHash('sha256').update(t).digest('hex');
  const user = s.upsertUser('admin', 'pw');
  s.insertToken({ token_hash: h('t1'), kind: 'access', client_id: 'c', user_id: user.id, scopes: 'mcp:tools', resource: null, expires_at: now + 1000, created_at: now, revoked: 0 });
  s.insertToken({ token_hash: h('t2'), kind: 'access', client_id: 'c', user_id: user.id, scopes: 'mcp:tools', resource: null, expires_at: now - 1, created_at: now, revoked: 0 });
  assert.ok(s.getToken('t1', 'access'));
  assert.equal(s.getToken('t2', 'access'), undefined, 'expired');
  assert.equal(s.getToken('t1', 'refresh'), undefined, 'kind mismatch');
  s.revokeToken('t1');
  assert.equal(s.getToken('t1', 'access'), undefined, 'revoked');
  s.close();
});
test('store preserves administrator id and password hash when password is unchanged', () => {
  const s = SqliteStore.open(':memory:');
  try {
    const first = s.upsertUser('admin', 'pw');
    const second = s.upsertUser('admin', 'pw');
    assert.equal(second.id, first.id);
    assert.equal(second.password_hash, first.password_hash);
    const changed = s.upsertUser('admin', 'new-pw');
    assert.equal(changed.id, first.id);
    assert.notEqual(changed.password_hash, first.password_hash);
    assert.ok(verifyPassword('new-pw', changed.password_hash));
  } finally {
    s.close();
  }
});

test('OAuth rejects authorization codes, access tokens, refresh tokens, and API keys with missing owners', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'brc-oauth-owners-'));
  const file = path.join(directory, 'relay.sqlite');
  SqliteStore.initialize(file);
  const s = SqliteStore.open(file);
  try {
    const user = s.upsertUser('admin', 'pw');
    s.createApiKey(user.id, 'valid key');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = OFF');
    const now = Date.now();
    const code = (value) => ({
      code: value, client_id: 'client', user_id: 'missing-user', code_challenge: 'challenge',
      redirect_uri: 'https://client.invalid/callback', scopes: 'mcp:tools', resource: null, expires_at: now + 60_000,
    });
    const insertCode = db.prepare('INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,?)');
    for (const value of ['stale-challenge', 'stale-exchange']) {
      const row = code(value);
      insertCode.run(row.code, row.client_id, row.user_id, row.code_challenge, row.redirect_uri, row.scopes, row.resource, row.expires_at);
    }
    const insertToken = db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?,?)');
    insertToken.run(sha256('stale-access'), 'access', 'client', 'missing-user', 'mcp:tools', null, now + 60_000, now, 0);
    insertToken.run(sha256('stale-refresh'), 'refresh', 'client', 'missing-user', 'mcp:tools', null, now + 60_000, now, 0);
    const apiKey = 'brc_ak_stale-api-key';
    db.prepare('INSERT INTO api_keys (key_hash,user_id,name,prefix,created_at) VALUES (?,?,?,?,?)')
      .run(sha256(apiKey), 'missing-user', 'stale key', apiKey.slice(0, 18), now);
    db.close();
    const provider = new RelayOAuthProvider({
      store: s,
      tokens: { randomToken, sha256 },
      currentUserId: () => null,
      renderLogin: () => {},
      renderConsent: () => {},
      issuer: 'https://relay.invalid',
    }, new RelayClientsStore(s, { randomToken, sha256 }));
    const client = { client_id: 'client' };
    const outcomes = await Promise.allSettled([
      provider.challengeForAuthorizationCode(client, 'stale-challenge'),
      provider.exchangeAuthorizationCode(client, 'stale-exchange'),
      provider.exchangeRefreshToken(client, 'stale-refresh'),
      provider.verifyAccessToken('stale-access'),
      provider.verifyAccessToken(apiKey),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
  } finally {
    s.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('login limiter locks after N failures and clears on success', () => {
  const l = new LoginLimiter(3, 60_000);
  assert.equal(l.locked('k'), 0);
  l.fail('k'); l.fail('k');
  assert.equal(l.locked('k'), 0);
  l.fail('k');
  assert.ok(l.locked('k') > 0);
  assert.equal(l.locked('other'), 0);
  l.ok('k');
  assert.equal(l.locked('k'), 0);
});

// Fake ws socket: EventEmitter with send/close/terminate and OPEN state
import { EventEmitter } from 'node:events';
class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closed = null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006, ''); }
  recv(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}
const hello = (id, tools = [{ name: 'echo', description: 'x', inputSchema: {} }]) => ({ type: 'hello', protocol: 1, device: { deviceId: id, name: id, platform: 'linux', arch: 'x64', hostname: 'h', agentVersion: '1', coreVersion: '1' }, tools });

test('device hub: hello/welcome, call/result matching, protocol + id checks, default resolution', async () => {
  const hub = new DeviceHub('t', () => {});
  const a = new FakeSocket();
  hub.attach(a, 'u1', 'devA');
  a.recv({ ...hello('wrong-id') });
  assert.equal(a.closed?.code, 4403, 'hello deviceId must match paired token');

  const b = new FakeSocket();
  hub.attach(b, 'u1', 'devA');
  b.recv(hello('devA'));
  assert.equal(b.sent[0]?.type, 'welcome');
  assert.equal(hub.resolveDefault('u1'), 'devA');
  assert.equal(hub.resolveDefault('u2'), null, 'other user sees nothing');

  const p = hub.call('devA', 'echo', { x: 1 }, { timeoutMs: 2000 });
  const callMsg = b.sent.find((m) => m.type === 'call');
  assert.equal(callMsg.tool, 'echo');
  b.recv({ type: 'result', id: callMsg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal((await p).content[0].text, 'ok');

  await assert.rejects(hub.call('devA', 'nope', {}), /UNKNOWN_TOOL/);
  await assert.rejects(hub.call('devB', 'echo', {}), /DEVICE_OFFLINE/);
  const t = hub.call('devA', 'echo', {}, { timeoutMs: 50 });
  await assert.rejects(t, /CALL_TIMEOUT/);

  const c = new FakeSocket();
  hub.attach(c, 'u1', 'devB');
  c.recv(hello('devB'));
  assert.equal(hub.resolveDefault('u1'), null, 'two devices -> ambiguous');

  const old = new FakeSocket();
  hub.attach(old, 'u1', 'devA');
  old.recv({ ...hello('devA'), protocol: 99 });
  assert.equal(old.closed?.code, 1002, 'protocol mismatch rejected');
  hub.close();
});