import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ReleaseProgress } from '../scripts/release-progress.mjs';
import { ReleaseRunner } from '../scripts/release-runner.mjs';
import { assertRegistryIntegrity, registryRepublishAt } from '../scripts/npm-registry-policy.mjs';
import { assertReleaseVersion } from '../scripts/release-version.mjs';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/release-brc.mjs');
function execute(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 8_000, windowsHide: true,
  });
}

test('release automation advertises a safe dry-run mode', () => {
  const result = execute('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm release:brc \[--dry-run\]/);
  assert.match(result.stdout, /without uploading or tagging/);
});

test('dry-run retains package and isolated E2E validation', () => {
  const source = readFileSync(script, 'utf8');
  const unit = source.indexOf("await runStage('Unit tests'");
  const packageTest = source.indexOf("await runStage('Package install and upgrade tests'");
  const e2e = source.indexOf("await runStage('Traefik OAuth and MCP E2E'");
  const dryRunExit = source.indexOf('if (dryRun) {', unit);
  assert.ok(unit >= 0 && unit < packageTest && packageTest < e2e && e2e < dryRunExit);
});

test('release automation rejects unsupported arguments before publishing', () => {
  const result = execute('--publish-immediately');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: pnpm release:brc/);
});

test('publishing requires a local interactive terminal before build or network work', () => {
  const result = execute();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /local interactive terminal/);
});

test('runner captures subprocess output and progress displays stage details', async () => {
  const output = { isTTY: false, data: '', write(text) { this.data += text; } };
  const progress = new ReleaseProgress({ output });
  const runner = new ReleaseRunner();
  progress.start('Build package');
  const result = await runner.run(process.execPath, ['-e', "process.stdout.write('BRC_PROGRESS:45\\nfinished\\n')"], {
    cwd: process.cwd(),
    onOutput(_stream, text) {
      const match = text.match(/BRC_PROGRESS:(\d{1,3})/);
      if (match) progress.detail(match[1] + '% gzip');
    },
  });
  assert.match(result.stdout, /finished/);
  assert.equal(progress.current.detail, '45% gzip');
  progress.finish();
  assert.match(output.data, /Build package/);
  assert.match(output.data, /✓/);
  assert.doesNotMatch(output.data, /\x1b\[2K/);
});

test('progress renderer refreshes a terminal while a stage runs', async () => {
  const output = { isTTY: true, data: '', write(text) { this.data += text; } };
  const progress = new ReleaseProgress({ output });
  progress.start('Working');
  await new Promise((resolve) => setTimeout(resolve, 280));
  progress.finish();
  assert.match(output.data, /\r\x1b\[2K/);
  assert.match(output.data, /[|/\-\\]/);
  assert.match(output.data, /✓/);
});

test('real release shows distinct upload, registry and tag progress stages', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /await runStage\('Upload npm package',.*command\('npm', \['publish'/);
  assert.match(source, /await runStage\('Wait for npm registry'/);
  assert.match(source, /await runStage\('Verify release tag'/);
});

test('runner preserves concise subprocess errors', async () => {
  const runner = new ReleaseRunner();
  await assert.rejects(
    runner.run(process.execPath, ['-e', "console.error('known failure');process.exit(3)"]),
    /known failure/,
  );
});

test('progress renderer does not execute subprocesses', () => {
  const progress = new ReleaseProgress({ output: { write() {} } });
  assert.equal(typeof progress.start, 'function');
  assert.equal(typeof progress.detail, 'function');
  assert.equal(typeof progress.finish, 'function');
});

test('only the public CLI manifest declares a product version', () => {
  const read = (file) => JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  const published = read('packages/cli/package.json');
  assert.match(published.version, /^\d+\.\d+\.\d+$/);
  for (const file of ['package.json', 'packages/shared/package.json', 'packages/relay/package.json', 'packages/agent/package.json']) {
    assert.equal(Object.hasOwn(read(file), 'version'), false, file);
  }
  const release = readFileSync(script, 'utf8');
  assert.match(release, /const version = manifest.version;/);
  assert.match(release, /assertReleaseVersion\(version, publishedVersion\(\)\)/);
  assert.doesNotMatch(release, /versionForRelease|rootManifest/);
  assert.doesNotMatch(readFileSync(path.resolve('scripts/pack-brc.mjs'), 'utf8'), /requestedVersion|--version=/);
});

test('release requires a higher explicit CLI version than npm', () => {
  assert.doesNotThrow(() => assertReleaseVersion('2.1.1', '2.1.0'));
  assert.doesNotThrow(() => assertReleaseVersion('2.1.1', null));
  assert.throws(() => assertReleaseVersion('2.1.1', '2.1.1'), /must exceed published/);
  assert.throws(() => assertReleaseVersion('2.1.1', '2.1.2'), /must exceed published/);
  assert.throws(() => assertReleaseVersion('2.1.1', '3.0.0'), /must exceed published/);
  assert.throws(() => assertReleaseVersion('invalid', null), /Invalid release version/);
});


test('interactive runner inherits stdin and displays child output', () => {
  const source = [
    "import { ReleaseRunner } from './scripts/release-runner.mjs';",
    "const runner = new ReleaseRunner();",
    "await runner.run(process.execPath, ['-e',",
    "  \"process.stdin.once('data', v => { console.log('RECEIVED:' + v.toString().trim()); });\"",
    "], { interactive: true });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.resolve('.'), input: 'test-otp-input\n', encoding: 'utf8', timeout: 8_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RECEIVED:test-otp-input/);
});

test('npm unpublished package names are blocked for 24 hours before building', () => {
  const notice = '{"error":{"summary":"Unpublished on 2026-10-31T05:18:46.137Z"}}';
  assert.equal(registryRepublishAt(notice, Date.parse('2026-10-31T14:00:00Z')), '2026-11-01T05:18:46.137Z');
  assert.equal(registryRepublishAt(notice, Date.parse('2026-11-01T05:18:47Z')), null);
  assert.equal(registryRepublishAt('{"error":{"summary":"Not Found"}}'), null);
  assert.match(readFileSync(script, 'utf8'), /registryRepublishAt\(details\)/);
});

test('registry verification rejects a same-version archive with different integrity', () => {
  const archive = Buffer.from('verified package');
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  assert.doesNotThrow(() => assertRegistryIntegrity({ name: '@inoceanlee/brc', version: '2.1.2', integrity }, {
    name: '@inoceanlee/brc', version: '2.1.2', dist: { integrity },
  }));
  assert.throws(() => assertRegistryIntegrity({ name: '@inoceanlee/brc', version: '2.1.2', integrity }, {
    name: '@inoceanlee/brc', version: '2.1.2', dist: { integrity: 'sha512-wrong' },
  }), /integrity/);
});


test('release automation is exposed only as a dedicated package command', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(manifest.scripts['release:brc'], 'node scripts/release-brc.mjs');
});
