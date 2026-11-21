import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { snapshotStaleAfterMs, SNAPSHOT_STALE_MULTIPLIER, SNAPSHOT_STALE_MIN_MS } from '../packages/shared/dist/index.js';
import { LoginLimiter } from '../packages/relay/dist/core/auth/rate-limit.js';
import { loadConfig } from '../packages/relay/dist/adapters/http/config.js';
import { SqliteStore } from '../packages/relay/dist/adapters/storage/sqlite.js';
import { RelayAuditLog } from '../packages/relay/dist/adapters/storage/relay-audit.js';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('snapshot staleness comes from one shared policy', async () => {
  assert.equal(SNAPSHOT_STALE_MULTIPLIER, 3);
  assert.equal(SNAPSHOT_STALE_MIN_MS, 60_000);
  assert.equal(snapshotStaleAfterMs(1000), 60_000);
  assert.equal(snapshotStaleAfterMs(30_000), 90_000);
  for (const file of [
    '../packages/cli/src/cli.ts',
    '../packages/relay/src/cli.ts',
    '../packages/agent/src/cli.ts',
  ]) {
    const text = await source(file);
    assert.doesNotMatch(text, /Math\.max\([^\n]*\*\s*3\s*,\s*60_000\)/, file);
  }
});

test('login limiter receives thresholds from configuration', () => {
  assert.throws(() => new LoginLimiter(), /maxFails|required|lockMs/i);
  const limiter = new LoginLimiter(2, 1000);
  limiter.fail('user');
  limiter.fail('user');
  assert.ok(limiter.locked('user') > 0);
  const config = loadConfig({});
  assert.equal(typeof config.auth.maxFails, 'number');
  assert.equal(typeof config.auth.lockMs, 'number');
  assert.ok(config.auth.maxFails > 0 && config.auth.lockMs > 0);
});

test('product version is set by the entrypoint, not read in core', async () => {
  const versionModule = await import('../packages/agent/dist/core/version.js');
  assert.equal(typeof versionModule.setProductVersion, 'function');
  versionModule.setProductVersion('9.9.9');
  assert.equal(versionModule.VERSION, '9.9.9');
  versionModule.setProductVersion(undefined);
  assert.equal(versionModule.VERSION, 'unknown');
  assert.doesNotMatch(await source('../packages/agent/src/core/version.ts'), /process\.env/);
});

test('relay audit log is injected into the store instead of created lazily', async () => {
  const storeSource = await source('../packages/relay/src/adapters/storage/sqlite.ts');
  assert.doesNotMatch(storeSource, /getAuditLog/);
  assert.doesNotMatch(storeSource, /private auditLog/);
  const cliSource = await source('../packages/relay/src/cli.ts');
  assert.match(cliSource, /RelayAuditLog\.open/);

  const audit = RelayAuditLog.open({ dbFile: ':memory:' });
  const store = SqliteStore.open(':memory:', audit);
  assert.deepEqual(store.recentAudit('u'), []);
});
