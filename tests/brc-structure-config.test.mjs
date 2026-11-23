import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginLimiter } from '../packages/relay/dist/core/auth/rate-limit.js';
import { loadConfig } from '../packages/relay/dist/adapters/http/config.js';
import { SqliteStore } from '../packages/relay/dist/adapters/storage/sqlite.js';
import { RelayAuditLog } from '../packages/relay/dist/adapters/storage/relay-audit.js';

test('login limiter receives thresholds from configuration', () => {
  assert.throws(() => new LoginLimiter(), /maxFails|required|lockMs/i);
  const limiter = new LoginLimiter(2, 1000);
  limiter.fail('user');
  limiter.fail('user');
  assert.ok(limiter.locked('user') > 0);
  const config = loadConfig({});
  assert.ok(config.auth.maxFails > 0 && config.auth.lockMs > 0);
});

test('relay audit log is injected into the store instead of created lazily', async () => {
  const audit = RelayAuditLog.open({ dbFile: ':memory:' });
  const store = SqliteStore.open(':memory:', audit);
  assert.deepEqual(store.recentAudit('u'), []);
});
