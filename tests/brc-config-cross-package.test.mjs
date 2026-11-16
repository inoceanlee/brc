import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { AgentConfigManager } from '../packages/agent/dist/adapters/storage/config-manager.js';
import { resolveAgentPaths } from '../packages/agent/dist/adapters/storage/agent-paths.js';
import { resolveSettings } from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

test('Agent writes keep the shared last-good config current for CLI rollback', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-cross-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { BRC_DATA_ROOT: root };
  const paths = resolveBrcPaths(env);
  const agentPaths = resolveAgentPaths({ ...env, BRC_CONFIG_FILE: path.join(paths.config, 'brc.yaml') });
  const agent = new AgentConfigManager({ paths: agentPaths, env });
  let applyCount = 0;
  const manager = await SettingsManager.load(paths, env, {
    lock: { runExclusive: async (operation) => operation() },
    apply: async () => {
      applyCount++;
      if (applyCount === 1) throw new Error('runtime apply failed');
    },
  });

  await manager.ensureConfigFile();
  await agent.setValue('allowedDirectories', ['C:\\workspace']);
  await assert.rejects(manager.apply(), /runtime apply failed/);

  const config = resolveSettings(yaml.safeLoad(readFileSync(agentPaths.configFile, 'utf8')), {});
  assert.deepEqual(config.fileSettings.agent.allowedDirectories, ['C:\\workspace']);
});
