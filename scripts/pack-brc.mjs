import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLockedRuntimeDependencies } from './release-dependencies.mjs';
import { pruneStagedDependencies } from './release-prune.mjs';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(process.argv[2] ?? path.join(workspaceRoot, 'dist-pack'));
const options = new Set(process.argv.slice(3));
if ([...options].some((option) => option !== '--with-next-patch')) {
  throw new Error('Usage: node scripts/pack-brc.mjs <output> [--with-next-patch]');
}
const withNextPatch = options.has('--with-next-patch');
const packageDir = path.join(workspaceRoot, 'packages');
const workDir = await mkdtemp(path.join(os.tmpdir(), 'brc-pack-'));
const stageDir = path.join(workDir, 'package');
const isolatedPnpmHome = path.join(workDir, 'pnpm-home');
const isolatedStore = path.join(workDir, 'pnpm-store');
const isolatedCache = path.join(workDir, 'pnpm-cache');
const isolatedState = path.join(workDir, 'pnpm-state');
const sourcePackages = ['cli', 'relay', 'agent', 'shared'];

function resolvePnpmCommand() {
  if (process.platform !== 'win32') return { file: 'pnpm', shell: false };
  const result = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Cannot find pnpm on PATH.');
  const candidates = result.stdout.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean);
  const file = candidates.find((candidate) => /\.exe$/i.test(candidate))
    ?? candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate));
  if (!file) throw new Error('Cannot find an executable pnpm command on PATH.');
  return { file, shell: !/\.exe$/i.test(file) };
}

const pnpmCommand = resolvePnpmCommand();

const pnpmIsolationEnv = {
  PNPM_HOME: isolatedPnpmHome,
  PNPM_CONFIG_STORE_DIR: isolatedStore,
  PNPM_CONFIG_STATE_DIR: isolatedState,
  PNPM_CONFIG_CACHE_DIR: isolatedCache,
};

function verifyPnpmIsolation() {
  for (const [setting, expected] of [
    ['store-dir', isolatedStore],
    ['state-dir', isolatedState],
    ['cache-dir', isolatedCache],
  ]) {
    const result = spawnSync(pnpmCommand.file, ['config', 'get', setting], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      shell: pnpmCommand.shell,
      timeout: 10_000,
      env: { ...process.env, ...pnpmIsolationEnv },
    });
    if (result.error) throw result.error;
    const actual = path.resolve(result.stdout.trim());
    if (result.status !== 0 || actual.toLowerCase() !== path.resolve(expected).toLowerCase()) {
      throw new Error(`pnpm ${setting} did not resolve to the isolated temporary directory.`);
    }
  }
}

function runPnpm(args, cwd) {
  const { file: command, shell } = pnpmCommand;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    timeout: 300_000,
    shell,
    env: { ...process.env, ...pnpmIsolationEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}`);
}

async function maximizeGzipCompression(destination, version) {
  const archive = path.join(destination, `inoceanlee-brc-${version}.tgz`);
  const staging = `${archive}.gzip-level-9`;
  const total = (await stat(archive)).size;
  let consumed = 0;
  let lastPercent = -5;
  const progress = new Transform({
    transform(chunk, _encoding, done) {
      consumed += chunk.length;
      const percent = Math.min(100, Math.floor((consumed / total) * 20) * 5);
      if (percent >= lastPercent + 5) {
        process.stdout.write(`BRC_PROGRESS:${percent}\n`);
        lastPercent = percent;
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(archive),
      progress,
      createGunzip(),
      createGzip({ level: 9 }),
      createWriteStream(staging, { flags: 'wx' }),
    );
    await rename(staging, archive);
  } finally {
    await rm(staging, { force: true });
  }
}

function collectRuntimeDependencies(manifests) {
  const dependencies = {};
  for (const manifest of manifests) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name === 'brc-shared') continue;
      if (dependencies[name] && dependencies[name] !== version) {
        throw new Error(`Conflicting runtime dependency versions for ${name}: ${dependencies[name]} and ${version}`);
      }
      dependencies[name] = version;
    }
  }
  return dependencies;
}

function formatPruneDetail(pruning) {
  const megabytes = (pruning.bytesRemoved / (1024 * 1024)).toFixed(1);
  return `精简完成 (${pruning.filesRemoved} 个文件，${megabytes} MiB)`;
}

try {
  verifyPnpmIsolation();
  process.stdout.write('BRC_DETAIL:构建工作区包\n');
  runPnpm(['-r', '--filter', './packages/*', 'build'], workspaceRoot);
  process.stdout.write('BRC_DETAIL:校验 Windows 原生进程查询器\n');
  const native = spawnSync(process.execPath, [path.join(workspaceRoot, 'scripts', 'build-native.mjs')], {
    cwd: workspaceRoot, stdio: 'inherit', windowsHide: true, timeout: 240_000,
  });
  if (native.error) throw native.error;
  if (native.status !== 0) throw new Error('Native process inspector build failed.');

  const manifests = await Promise.all(sourcePackages.map(async (name) =>
    JSON.parse(await readFile(path.join(packageDir, name, 'package.json'), 'utf8'))));
  const [cliManifest, , , sharedManifest] = manifests;
  const releaseVersion = cliManifest.version;
  if (typeof releaseVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error('Missing or invalid CLI product version.');
  }
  const bundledSharedManifest = { ...sharedManifest, version: releaseVersion };
  const dependencies = collectRuntimeDependencies(manifests);
  dependencies['brc-shared'] = `file:vendor/brc-shared`;

  await mkdir(path.join(stageDir, 'dist', 'services'), { recursive: true });
  await mkdir(path.join(stageDir, 'vendor', 'brc-shared'), { recursive: true });
  await mkdir(path.join(stageDir, 'deploy'), { recursive: true });
  await cp(path.join(packageDir, 'cli', 'dist'), path.join(stageDir, 'dist'), { recursive: true });
  await cp(path.join(packageDir, 'relay', 'dist'), path.join(stageDir, 'dist', 'services', 'relay'), { recursive: true });
  await cp(path.join(packageDir, 'agent', 'dist'), path.join(stageDir, 'dist', 'services', 'agent'), { recursive: true });
  await cp(path.join(packageDir, 'shared', 'dist'), path.join(stageDir, 'vendor', 'brc-shared', 'dist'), { recursive: true });
  await writeFile(path.join(stageDir, 'vendor', 'brc-shared', 'package.json'), JSON.stringify(bundledSharedManifest, null, 2));
  await cp(path.join(workspaceRoot, 'deploy', 'traefik'), path.join(stageDir, 'deploy', 'traefik'), { recursive: true });
  const sourceDocuments = (await readdir(workspaceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const pattern of cliManifest.files.filter((file) => !['dist', 'deploy'].includes(file))) {
    const extension = /^\*\.([^.*/]+)$/.exec(pattern)?.[1];
    if (pattern.includes('*') && !extension) throw new Error('Unsupported package document pattern: ' + pattern);
    const matching = sourceDocuments.filter((name) =>
      extension ? name.endsWith('.' + extension) : name === pattern);
    if (!matching.length) throw new Error('Missing package document matching ' + pattern);
    for (const name of matching) {
      await cp(path.join(workspaceRoot, name), path.join(stageDir, name));
    }
  }

  const packageManifest = {
    ...cliManifest,
    version: releaseVersion,
    files: cliManifest.files,
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await mkdir(outputDir, { recursive: true });
  process.stdout.write('BRC_DETAIL:依照锁文件隔离安装运行依赖\n');
  await installLockedRuntimeDependencies({ workspaceRoot, stageDir, workDir, sourcePackages, runPnpm });
  process.stdout.write('BRC_DETAIL:精简暂存目录内的非运行时文件\n');
  const pruning = await pruneStagedDependencies(stageDir);
  process.stdout.write(`BRC_DETAIL:${formatPruneDetail(pruning)}\n`);

  const bundledSharedPath = path.join(stageDir, 'node_modules', 'brc-shared');
  await rm(bundledSharedPath, { recursive: true, force: true });
  await cp(path.join(stageDir, 'vendor', 'brc-shared'), bundledSharedPath, { recursive: true });
  await rm(path.join(stageDir, 'vendor'), { recursive: true, force: true });
  packageManifest.dependencies['brc-shared'] = releaseVersion;
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await chmod(path.join(stageDir, 'dist', 'cli.js'), 0o755);
  process.stdout.write('BRC_DETAIL:组装正式发行包\n');
  runPnpm(['pack', '--pack-destination', outputDir], stageDir);
  process.stdout.write('BRC_DETAIL:gzip 9 级压缩正式包\n');
  await maximizeGzipCompression(outputDir, packageManifest.version);
  if (withNextPatch) {
    const version = packageManifest.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!version) throw new Error(`Cannot create next-patch package from unstable version ${packageManifest.version}.`);
    packageManifest.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
    await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
    const nextPatchDir = path.join(outputDir, 'next-patch');
    await mkdir(nextPatchDir, { recursive: true });
    await runPnpm(['pack', '--pack-destination', nextPatchDir], stageDir);
    process.stdout.write('BRC_DETAIL:gzip 9 级压缩升级测试包\n');
    await maximizeGzipCompression(nextPatchDir, packageManifest.version);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
