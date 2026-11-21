import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cliSource = fileURLToPath(new URL('../packages/cli/src/', import.meta.url));

test('CLI source tree keeps core rules separate from adapters', async () => {
  const expected = [
    'core/traefik/rules.ts',
    'core/maintenance/ports.ts',
    'core/maintenance/uninstall.ts',
    'adapters/traefik/release.ts',
    'adapters/traefik/archive.ts',
    'adapters/traefik/input.ts',
    'adapters/traefik/output.ts',
    'adapters/traefik/manager.ts',
    'adapters/traefik/runtime.ts',
    'adapters/package/global-package.ts',
    'adapters/package/uninstall-worker.ts',
    'adapters/storage/logs.ts',
    'adapters/storage/uninstall.ts',
    'adapters/terminal/progress.ts',
  ];
  for (const relative of expected) {
    await assert.doesNotReject(access(path.join(cliSource, relative)), relative);
  }
  for (const relative of ['traefik', 'maintenance', 'progress.ts']) {
    await assert.rejects(access(path.join(cliSource, relative)), { code: 'ENOENT' }, relative);
  }
});

test('traefik rules expose version and configuration functions without adapter imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(path.join(cliSource, 'core', 'traefik', 'rules.ts'), 'utf8');
  assert.doesNotMatch(source, /from 'node:/);
  assert.doesNotMatch(source, /from '\.\.\/\.\.\/adapters/);
});
