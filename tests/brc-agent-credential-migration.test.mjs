import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateCredentialFile } from '../packages/agent/dist/adapters/storage/credential-migration.js';
import { CredentialStore } from '../packages/agent/dist/adapters/storage/credential-store.js';

const sample = { relayUrl: 'https://relay.example', deviceId: 'd1', deviceToken: 'private-token', name: 'PC', pairedAt: '2026-01-01' };

test('valid legacy device file migrates and is removed only after verified copy', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-credential-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy');
  const state = path.join(root, 'data', 'agent');
  mkdirSync(legacy);
  const source = path.join(legacy, 'device.json');
  writeFileSync(source, JSON.stringify(sample));
  assert.equal(migrateCredentialFile(source, state), true);
  assert.equal(existsSync(source), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, 'device.json'), 'utf8')), sample);
});

test('existing device credentials always win over old file', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-credential-conflict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy');
  const state = path.join(root, 'new');
  mkdirSync(legacy);
  mkdirSync(state);
  const source = path.join(legacy, 'device.json');
  writeFileSync(source, JSON.stringify(sample));
  writeFileSync(path.join(state, 'device.json'), JSON.stringify({ ...sample, deviceToken: 'already-new' }));
  assert.equal(migrateCredentialFile(source, state), false);
  assert.equal(existsSync(source), true);
  assert.equal(JSON.parse(readFileSync(path.join(state, 'device.json'), 'utf8')).deviceToken, 'already-new');
});

test('malformed legacy credential is preserved without creating target', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-credential-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'device.json');
  const state = path.join(root, 'new');
  writeFileSync(source, '{broken');
  assert.equal(migrateCredentialFile(source, state), false);
  assert.equal(readFileSync(source, 'utf8'), '{broken');
  assert.equal(existsSync(path.join(state, 'device.json')), false);
});


test('malformed destination credentials are not overwritten by legacy migration', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-credential-bad-destination-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'legacy');
  const target = path.join(root, 'data', 'agent');
  mkdirSync(legacy);
  mkdirSync(target, { recursive: true });
  const oldFile = path.join(legacy, 'device.json');
  const newFile = path.join(target, 'device.json');
  writeFileSync(oldFile, JSON.stringify(sample));
  writeFileSync(newFile, '{broken');
  assert.equal(migrateCredentialFile(oldFile, target), false);
  assert.equal(readFileSync(newFile, 'utf8'), '{broken');
  assert.equal(existsSync(oldFile), true);
});

test('malformed saved device credentials fail closed instead of triggering implicit pairing', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-credential-failclosed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CredentialStore(path.join(root, 'agent'));
  mkdirSync(path.join(root, 'agent'), { recursive: true });
  writeFileSync(path.join(root, 'agent', 'device.json'), '{broken');
  assert.throws(() => store.load(), /invalid|corrupt/i);
  assert.equal(readFileSync(path.join(root, 'agent', 'device.json'), 'utf8'), '{broken');
});
