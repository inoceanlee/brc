import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';

test('managed Agent receives the canonical BRC data and config paths', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-agent-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: root });
  const agent = createDefaultServices(paths, DEFAULT_SETTINGS, { BRC_DATA_ROOT: root })
    .find((service) => service.name === 'agent');
  assert.ok(agent);
  assert.equal(agent.env.BRC_DATA_ROOT, paths.root);
  assert.equal(agent.env.BRC_CONFIG_FILE, path.join(paths.config, 'brc.yaml'));
  assert.equal(Object.hasOwn(agent.env, 'BRC_HOME'), false);
});
