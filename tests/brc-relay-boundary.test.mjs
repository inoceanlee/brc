import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const relay = path.join(root, 'packages/relay/src');
const source = (file) => readFileSync(path.join(relay, file), 'utf8');

test('relay core contains pure authorization policy and ports', () => {
  assert.ok(existsSync(path.join(relay, 'core/auth/ports.ts')));
  for (const file of readdirSync(path.join(relay, 'core/auth')).filter((name) => name.endsWith('.ts'))) {
    const text = source('core/auth/' + file);
    assert.doesNotMatch(text, /from\s+['"](?:node:|express|@modelcontextprotocol|.*adapters\/)/);
  }
});

test('relay external integrations live in adapters and are composed by entry', () => {
  assert.ok(existsSync(path.join(relay, 'adapters/http/oauth-provider.ts')));
  assert.ok(existsSync(path.join(relay, 'adapters/transport/device-hub.ts')));
  assert.ok(!existsSync(path.join(relay, 'device-hub.ts')));
  assert.ok(!existsSync(path.join(relay, 'core/auth/provider.ts')));
  assert.doesNotMatch(source('adapters/http/app.ts'), /new (?:SqliteStore|DeviceHub|RelayOAuthProvider|Sessions|LoginLimiter|WebSocketServer)\b/);
  assert.doesNotMatch(source('adapters/http/oauth-provider.ts'), /new RelayClientsStore\b/);
  assert.match(source('cli.ts'), /new RelayClientsStore\b/);
});

test('relay configuration uses shared settings instead of local defaults', () => {
  assert.match(source('adapters/http/config.ts'), /resolveSettings/);
  assert.doesNotMatch(source('cli.ts'), /applyLegacyEnv/);
});