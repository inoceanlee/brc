import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const migrationUrl = new URL('../packages/cli/dist/adapters/storage/migration.js', import.meta.url).href;

async function makeHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brc-migration-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('entry migration finds no legacy identity on a clean data root', async (t) => {
  const home = await makeHome(t);
  const root = path.join(home, 'new-root');
  const { discoverLegacyIdentityCandidates } = await import(migrationUrl);
  const candidates = discoverLegacyIdentityCandidates({
    root, data: path.join(root, 'data'), config: path.join(root, 'config'),
  }, {}, home);
  assert.deepEqual(candidates, []);
});

test('entry migration detects a legacy identity database outside the active root', async (t) => {
  const home = await makeHome(t);
  const legacy = path.join(home, '.brc');
  await mkdir(path.join(legacy, 'data'), { recursive: true });
  await writeFile(path.join(legacy, 'data', 'relay.sqlite'), 'legacy identity');
  const root = path.join(home, 'new-root');
  const { discoverLegacyIdentityCandidates } = await import(migrationUrl);
  const candidates = discoverLegacyIdentityCandidates({
    root, data: path.join(root, 'data'), config: path.join(root, 'config'),
  }, {}, home);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'identity-database');
  assert.equal(candidates[0].path, path.join(legacy, 'data', 'relay.sqlite'));
});

test('entry migration skips a migrated legacy identity recorded by the import marker', async (t) => {
  const home = await makeHome(t);
  const legacy = path.join(home, '.brc');
  await mkdir(path.join(legacy, 'data'), { recursive: true });
  const legacyFile = path.join(legacy, 'data', 'relay.sqlite');
  await writeFile(legacyFile, 'legacy identity');
  const root = path.join(home, 'new-root');
  const paths = { root, data: path.join(root, 'data'), config: path.join(root, 'config') };
  await mkdir(paths.data, { recursive: true });
  const diagnostics = new DatabaseSync(path.join(paths.data, 'brc-diagnostics.sqlite'));
  try {
    diagnostics.exec('CREATE TABLE relay_identity_imports (source_key TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)');
    const key = createHash('sha256').update(path.resolve(legacyFile)).digest('hex');
    diagnostics.prepare('INSERT INTO relay_identity_imports (source_key, imported_at) VALUES (?, ?)').run(key, Date.now());
  } finally {
    diagnostics.close();
  }
  const { discoverLegacyIdentityCandidates, assertNoLegacyIdentity } = await import(migrationUrl);
  const candidates = discoverLegacyIdentityCandidates(paths, {}, home);
  assert.deepEqual(candidates, []);
  assert.doesNotThrow(() => assertNoLegacyIdentity(candidates));
});

test('entry migration refuses a silent new identity when legacy data is present', async () => {
  const { assertNoLegacyIdentity } = await import(migrationUrl);
  const candidates = [{ kind: 'identity-database', path: 'C:/legacy/relay.sqlite' }];
  assert.throws(() => assertNoLegacyIdentity(candidates), (error) =>
    error.exitCode === 5 && /legacy/i.test(error.message) && /relay\.sqlite/.test(error.message));
  assert.doesNotThrow(() => assertNoLegacyIdentity([]));
});

test('setup proceeds when the entry scan found legacy data and the new database is absent', async (t) => {
  const { runCli } = await import(new URL('../packages/cli/dist/cli.js', import.meta.url).href);
  const home = await makeHome(t);
  const legacy = path.join(home, 'old');
  await mkdir(path.join(legacy, 'data'), { recursive: true });
  await writeFile(path.join(legacy, 'data', 'relay.sqlite'), 'legacy identity');
  const errors = [];
  let setupCalls = 0;
  const root = path.join(home, 'new-root');
  const exitCode = await runCli(['setup'], {
    paths: {
      root, traefik: path.join(root, 'traefik'), config: path.join(root, 'config'), data: path.join(root, 'data'),
      runtime: path.join(root, 'runtime'), logs: path.join(root, 'logs'), diagnostics: path.join(root, 'diagnostics'), tmp: path.join(root, 'tmp'),
    },
    commands: { setup: async () => { setupCalls += 1; return 0; } },
    legacyCandidates: [{ kind: 'identity-database', path: path.join(legacy, 'data', 'relay.sqlite') }],
    clean: async () => {},
    write: () => {},
    writeError: (message) => errors.push(message),
  });
  assert.equal(exitCode, 0);
  assert.equal(setupCalls, 1);
  assert.deepEqual(errors, []);
});
