import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASE_CONFIG } from './release-config.mjs';
import { ReleaseArtifactStore, ReleaseLock } from './release-artifact.mjs';
import { ReleaseProgress } from './release-progress.mjs';
import { ReleaseRunner } from './release-runner.mjs';
import { withReleaseWorkspace } from './release-workspace.mjs';
import { assertRegistryIntegrity, registryRepublishAt } from './npm-registry-policy.mjs';
import { assertReleaseVersion } from './release-version.mjs';
import { releaseActions } from './release-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const verifyOnly = process.argv.includes('--verify-only');
const verbose = process.argv.includes('--verbose');
const help = process.argv.includes('--help');
if (process.argv.slice(2).some((arg) => !['--dry-run', '--verbose', '--help', '--verify-only'].includes(arg))) {
  throw new Error('Usage: pnpm release:brc [--dry-run] [--verbose] [--verify-only]');
}
if (help) {
  console.log('pnpm release:brc [--dry-run] [--verbose] [--verify-only]');
  console.log('Validate, build, test and publish @inoceanlee/brc with the configured npm token.');
  console.log('Use --dry-run to validate without uploading or tagging.');
  console.log('Use --verify-only to verify a published release without publishing or pushing.');
  process.exit(0);
}

const actions = releaseActions({ dryRun, verifyOnly });
const progress = new ReleaseProgress({ verbose });
const runner = new ReleaseRunner();
const store = new ReleaseArtifactStore();
const lock = new ReleaseLock(path.join(RELEASE_CONFIG.artifactDirectory, '.release-lock'));

function resolveBinary(command) {
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) return { file: command, prefix: [] };
  const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (found.status !== 0) throw new Error('Missing ' + command + ' on PATH.');
  const files = found.stdout.split(/\r?\n/).filter(Boolean);
  if (command === 'npm') {
    const cmd = files.find((file) => /npm\.cmd$/i.test(file));
    if (!cmd) throw new Error('Cannot locate npm.cmd.');
    const entrypoint = path.join(path.dirname(cmd), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(entrypoint)) throw new Error('Cannot locate npm CLI entrypoint: ' + entrypoint);
    return { file: process.execPath, prefix: [entrypoint] };
  }
  const executable = files.find((file) => /\.exe$/i.test(file));
  if (!executable) throw new Error('Cannot locate pnpm executable.');
  return { file: executable, prefix: [] };
}
const executables = Object.fromEntries(['git', 'npm', 'pnpm'].map((command) => [command, resolveBinary(command)]));

function quick(command, args, { allowFailure = false } = {}) {
  const executable = executables[command] ?? { file: command, prefix: [] };
  const result = spawnSync(executable.file, [...executable.prefix, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(command + ' ' + args[0] + ' failed: ' + (result.stderr || result.stdout).slice(-1200));
  }
  return result;
}
const git = (...args) => quick('git', args).stdout.trim();

async function command(tool, args, options = {}) {
  const executable = executables[tool] ?? { file: tool, prefix: [] };
  return runner.run(executable.file, [...executable.prefix, ...args], {
    cwd: root,
    ...options,
    onOutput(stream, text) {
      options.onOutput?.(stream, text);
      const details = text.match(/BRC_DETAIL:([^\r\n]+)/g);
      if (details) progress.detail(details.at(-1).slice('BRC_DETAIL:'.length));
      const percentages = text.match(/BRC_PROGRESS:(\d{1,3})/g);
      if (percentages) progress.detail(percentages.at(-1).slice('BRC_PROGRESS:'.length) + '% gzip');
    },
  });
}

function hashBuildInputs(revision) {
  const files = ['pnpm-lock.yaml', 'scripts/pack-brc.mjs', 'scripts/release-config.mjs', 'scripts/release-artifact.mjs'];
  const hash = createHash('sha256').update(revision);
  for (const filename of files.sort()) hash.update(filename).update(readFileSync(path.join(root, filename)));
  return hash.digest('hex');
}

function registryVersion(version) {
  const result = quick('npm', ['view', RELEASE_CONFIG.packageName + '@' + version, '--json', '--registry', RELEASE_CONFIG.registry], { allowFailure: true });
  if (result.status !== 0) {
    const details = (result.stderr || '') + (result.stdout || '');
    const retryAt = registryRepublishAt(details);
    if (retryAt) throw new Error('npm registry is reserving this package name until ' + retryAt + ' (UTC).');
    if (/E404|Not Found/i.test(details)) return null;
    throw new Error('Registry lookup failed: ' + details.slice(-800));
  }
  return JSON.parse(result.stdout.trim());
}

function publishedVersion() {
  const result = quick('npm', ['view', RELEASE_CONFIG.packageName, 'version', '--json', '--registry', RELEASE_CONFIG.registry], { allowFailure: true });
  if (result.status !== 0) {
    const details = (result.stderr || '') + (result.stdout || '');
    if (/E404|Not Found/i.test(details)) return null;
    const retryAt = registryRepublishAt(details);
    if (retryAt) throw new Error('npm registry is reserving this package name until ' + retryAt + ' (UTC).');
    throw new Error('Registry lookup failed: ' + details.slice(-800));
  }
  return JSON.parse(result.stdout.trim());
}

async function verifyAndTag(artifact) {
  await runStage('Wait for npm registry', async () => {
    let metadata = null;
    for (let attempt = 0; attempt < RELEASE_CONFIG.registryAttempts; attempt++) {
      progress.detail(`Lookup ${attempt + 1}/${RELEASE_CONFIG.registryAttempts}`);
      metadata = registryVersion(artifact.version);
      if (metadata) break;
      if (attempt + 1 < RELEASE_CONFIG.registryAttempts) await new Promise((resolve) => setTimeout(resolve, RELEASE_CONFIG.registryPollMs));
    }
    if (!metadata) throw new Error('Registry publication is not visible yet. Keep the release checkpoint and rerun to verify.');
    assertRegistryIntegrity(artifact, metadata);
  });
  progress.print('  Registry content verified: ' + artifact.name + '@' + artifact.version);

  await runStage('Verify release tag', async () => {
    const localResult = quick('git', ['rev-parse', '--verify', artifact.tag + '^{commit}'], { allowFailure: true });
    const local = localResult.status === 0 ? localResult.stdout.trim() : '';
    if (local && local !== artifact.revision) throw new Error('Local release tag points to a different source revision.');
    const remoteResult = quick('git', ['ls-remote', 'origin', 'refs/tags/' + artifact.tag, 'refs/tags/' + artifact.tag + '^{}'], { allowFailure: true });
    if (remoteResult.status !== 0) throw new Error('Remote tag lookup failed: ' + remoteResult.stderr.slice(-800));
    const remoteLines = remoteResult.stdout.trim().split(/\r?\n/).filter(Boolean);
    const remoteCommit = remoteLines.find((line) => line.endsWith('refs/tags/' + artifact.tag + '^{}'))?.split(/\s+/)[0]
      ?? remoteLines.find((line) => line.endsWith('refs/tags/' + artifact.tag))?.split(/\s+/)[0];
    if (remoteCommit && remoteCommit !== artifact.revision) throw new Error('Remote release tag points to a different source revision.');
    if (!local && actions.publish) quick('git', ['tag', artifact.tag, artifact.revision]);
    if (!remoteCommit && actions.push) await command('git', ['push', 'origin', artifact.tag]);
    await store.markRegistryVerified(artifact);
  });
  progress.print('  Published and tagged: ' + artifact.name + '@' + artifact.version);
}

async function runStage(title, operation, options = {}) {
  progress.start(title, options);
  try {
    const result = await operation();
    progress.finish(result);
    return result;
  } catch (error) {
    progress.finish(error);
    throw error;
  }
}

async function release() {
  const branch = git('branch', '--show-current');
  if (!dryRun && !verifyOnly && branch !== 'main') throw new Error('Real releases must run from main.');
  if (git('status', '--porcelain')) throw new Error('Commit all changes before release.');
  const revision = git('rev-parse', 'HEAD');
  const manifest = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));
  if (manifest.name !== RELEASE_CONFIG.packageName) throw new Error('Unexpected npm package name.');
  const version = manifest.version;
  const tag = RELEASE_CONFIG.tagPrefix + version;
  const buildFingerprint = hashBuildInputs(revision);

  if (verifyOnly) {
    const artifact = await store.load(version);
    if (!artifact) throw new Error('No validated release artifact is available for verification.');
    progress.print('Verify-only: no package will be published and no tag will be pushed.');
    await verifyAndTag(artifact);
    return;
  }

  const pending = await store.load(version);
  if (pending?.publishAttempted) {
    if (dryRun) throw new Error('A publish attempt has unknown status. Dry-run will not query or modify the registry.');
    progress.print('  Verifying prior publish attempt: ' + pending.name + '@' + pending.version);
    await verifyAndTag(pending);
    return;
  }

  let artifact = await store.find({ revision, name: manifest.name, version, buildFingerprint });
  if (!artifact) {
    if (git('tag', '--points-at', 'HEAD', '--list', RELEASE_CONFIG.tagPrefix + '*')) throw new Error('Current source commit already released.');
    if (!dryRun) {
      if (git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] !== revision) throw new Error('Push main to origin before release.');
      const account = quick('npm', ['whoami', '--registry', RELEASE_CONFIG.registry]).stdout.trim();
      if (account !== 'inoceanlee') throw new Error('npm must be logged in as inoceanlee.');
      assertReleaseVersion(version, publishedVersion());
    }
    const traefik = process.env.BRC_TRAEFIK_TEST_BINARY || path.resolve(root, '../traefik/traefik.exe');
    if (!existsSync(traefik)) throw new Error('Traefik test binary missing: ' + traefik);
    progress.print('Release: ' + manifest.name + '@' + version);
    artifact = await withReleaseWorkspace(async (output) => {
      await runStage('Build package', () => command(process.execPath, [path.join(root, 'scripts/script-diagnostics.mjs'), path.join(root, 'scripts/pack-brc.mjs'), output, '--with-next-patch']));
      const archives = readdirSync(output).filter((file) => file.endsWith('.tgz'));
      const filename = 'inoceanlee-brc-' + version + '.tgz';
      if (archives.length !== 1 || archives[0] !== filename) throw new Error('Unexpected package archives.');
      const archive = path.join(output, filename);
      const nextArchive = path.join(output, 'next-patch', filename.replace(version, nextPatch(version)));
      if (!existsSync(nextArchive)) throw new Error('Missing upgrade test archive.');
      const env = { ...process.env, BRC_TRAEFIK_TEST_BINARY: traefik, BRC_PACKAGE_TARBALL: archive, BRC_PACKAGE_UPDATED_TARBALL: nextArchive };
      await runStage('Package install and upgrade tests', () => command('pnpm', ['test:package'], { env }));
      await runStage('Traefik OAuth and MCP E2E', () => command('pnpm', ['test:e2e'], { env }));
      if (dryRun) {
        progress.print('  Offline dry-run: registry, login, publish and tags were not accessed.');
        return null;
      }
      await runStage('Inspect npm package', () => command('npm', ['publish', archive, '--dry-run', '--access', 'public', '--registry', RELEASE_CONFIG.registry]));
      return store.save({
        archive, revision, name: manifest.name, version, tag, buildFingerprint,
        validations: { package: true, e2e: true, dryRun: true },
      });
    });
  }
  if (dryRun) {
    progress.print('Dry run passed. No package published or tag created.');
    return;
  }
  if (actions.publish) {
    progress.print('Validated archive reused: ' + artifact.archivePath);
    artifact.tag = tag;
    artifact = await store.markAttempted(artifact);
    artifact.tag = tag;
    await runStage('Upload npm package', () => command('npm', ['publish', artifact.archivePath, '--access', 'public', '--registry', RELEASE_CONFIG.registry]));
  } else {
    progress.print('Package upload skipped.');
  }
  await verifyAndTag(artifact);
}

function nextPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error('Invalid release version.');
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

lock.withExclusive(() => release(), { revision: 'pending' }).catch((error) => {
  console.error('\nRelease stopped: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
