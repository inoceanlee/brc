import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { resolveAgentPaths } from '../packages/agent/dist/adapters/storage/agent-paths.js';

test('explicit root owns config, credentials, state, caches, and logs', () => {
  const root = path.resolve('isolated-brc-agent-root');
  const paths = resolveAgentPaths({ BRC_DATA_ROOT: root });
  assert.equal(paths.root, root);
  assert.equal(paths.configFile, path.join(root, 'config', 'brc.yaml'));
  assert.equal(paths.credentialsFile, path.join(root, 'data', 'agent', 'device.json'));
  assert.equal(paths.historyDirectory, path.join(root, 'data', 'agent'));
  assert.equal(paths.usageFile, path.join(root, 'data', 'agent', 'usage.json'));
  assert.equal(paths.featureFlagFile, path.join(root, 'cache', 'agent', 'feature-flags.json'));
  assert.equal(paths.logsDirectory, path.join(root, 'logs'));
});

test('explicit config file does not change the persistent data root', () => {
  const root = path.resolve('root');
  const custom = path.resolve('elsewhere', 'brc.yaml');
  const paths = resolveAgentPaths({ BRC_DATA_ROOT: root, BRC_CONFIG_FILE: custom });
  assert.equal(paths.configFile, custom);
  assert.equal(paths.credentialsFile, path.join(root, 'data', 'agent', 'device.json'));
});

test('obsolete BRC_HOME does not affect resolved paths', () => {
  const root = path.resolve('root');
  assert.deepEqual(resolveAgentPaths({ BRC_DATA_ROOT: root, BRC_HOME: path.resolve('old') }), resolveAgentPaths({ BRC_DATA_ROOT: root }));
});
