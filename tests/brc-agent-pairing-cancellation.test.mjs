import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pairDevice } from '../packages/agent/dist/adapters/transport/pairing.js';

test('cancelled pairing does not call the Relay or save credentials', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brc-agent-abort-'));
  const fetchBefore = globalThis.fetch;
  const oldRoot = process.env.BRC_DATA_ROOT;
  t.after(() => {
    globalThis.fetch = fetchBefore;
    if (oldRoot === undefined) delete process.env.BRC_DATA_ROOT;
    else process.env.BRC_DATA_ROOT = oldRoot;
    rmSync(root, { force: true, recursive: true });
  });
  process.env.BRC_DATA_ROOT = root;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('unexpected network request'); };
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(pairDevice({
    relayUrl: 'https://relay.example', name: 'test', openBrowser: false,
    log: () => {}, signal: abort.signal,
  }), /abort/i);
  assert.equal(requests, 0);
});
