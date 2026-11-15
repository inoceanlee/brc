import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['brc-package.test.mjs']);
const TEST_CONCURRENCY = '2';

/**
 * Unit suites are discovered by filename convention so a new
 * `tests/brc-*.test.mjs` file joins the standard run automatically. Package
 * installation checks that need a packed artifact stay out of this set.
 */
export async function discoverUnitTests(base = root) {
  const entries = await readdir(path.join(base, 'tests'), { withFileTypes: true });
  const suites = entries
    .filter((entry) => entry.isFile() && /^brc-.*\.test\.mjs$/.test(entry.name) && !excluded.has(entry.name))
    .map((entry) => `tests/${entry.name}`);
  return ['packages/relay/test/unit.test.mjs', ...suites].sort();
}

export function runUnitTests(suites, options = {}) {
  const spawnChild = options.spawn ?? spawn;
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawnChild(process.execPath, [`--test-concurrency=${TEST_CONCURRENCY}`, '--test', ...suites], {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  return promise;
}

async function main() {
  const suites = await discoverUnitTests();
  if (suites.length === 0) throw new Error('No unit test suites were discovered.');
  process.exitCode = await runUnitTests(suites);
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  await main();
}
