import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS as sharedDefaults, BRC_SETTING_KEYS as sharedKeys } from '../packages/shared/dist/index.js';
import { DEFAULT_SETTINGS as cliDefaults, BRC_SETTING_KEYS as cliKeys } from '../packages/cli/dist/config/settings.js';

test('CLI settings use Shared schema, keys and immutable defaults without a duplicate source', () => {
  assert.equal(cliDefaults, sharedDefaults);
  assert.equal(cliKeys, sharedKeys);
  assert.equal(typeof cliDefaults.agent.defaultShell, 'string');
});
