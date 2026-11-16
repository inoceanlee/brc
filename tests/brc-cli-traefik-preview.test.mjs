import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TraefikManager } from '../packages/cli/dist/traefik/manager.js';
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';

test('Traefik update preview fetches target version without downloading or modifying install', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { root, traefik: path.join(root, 'traefik'), tmp: path.join(root, 'tmp') };
  await mkdir(paths.traefik);
  const manifest = path.join(paths.traefik, 'versions.json');
  const oldText = JSON.stringify({ version: 1, current: '3.7.16', previous: null });
  await writeFile(manifest, oldText);
  let releaseCalls = 0;
  const manager = new TraefikManager(paths, DEFAULT_SETTINGS, {
    withLock: async (task) => task(),
    status: async () => [],
  }, {
    input: {
      latestRelease: async () => { releaseCalls++; return { version: '3.7.17' }; },
      downloadArchive: async () => { throw new Error('preview must never download'); },
    },
  });
  const result = await manager.previewUpdate();
  assert.deepEqual(result, { current: '3.7.16', target: '3.7.17', changed: true });
  assert.equal(releaseCalls, 1);
  assert.equal(await readFile(manifest, 'utf8'), oldText);
});
