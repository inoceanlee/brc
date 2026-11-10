import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { SqliteStore } from '../packages/relay/dist/store/sqlite.js';
import os from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const requiredFiles = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/NOTICE',
  'package/dist/cli.js',
  'package/dist/native/win32-x64/brc-process.exe',
  'package/dist/services/relay/cli.js',
  'package/dist/services/agent/cli.js',
  'package/dist/maintenance/uninstall-worker.js',
  'package/deploy/traefik/traefik.yml',
  'package/deploy/traefik/dynamic.yml',
  'package/node_modules/brc-shared/package.json',
  'package/node_modules/unzipper/package.json',
];
const forbiddenFiles = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:\.npmrc|\.pnpmfile\.cjs)$/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials(?:\.json)?|secrets?)(?:\.[^/]*)?$/i,
  /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i,
  /(^|\/)traefik(?:\.exe)?$/i,
  /(^|\/)node_modules\/\.pnpm(?:\/|$)/,
];

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BRC_/i.test(name)));

async function allocateServicePorts() {
  const servers = [];
  try {
    while (servers.length < 3) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    const ports = servers.map((server) => server.address().port);
    assert.equal(new Set(ports).size, 3);
    assert.ok(ports.every((port) => ![3000, 13001, 13002].includes(port)));
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
}


function run(command, args, options = {}) {
  const isWindowsShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const normalizedArgs = command === 'tar' && process.platform === 'win32'
    ? args.map((arg) => arg.replaceAll('\\', '/'))
    : args;
  const cmdLine = [`"${command.replaceAll('"', '""')}"`, ...normalizedArgs.map((arg) => `"${arg.replaceAll('"', '""')}"`)].join(' ');
  const executable = isWindowsShim ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = isWindowsShim ? ['/d', '/s', '/c', `"${cmdLine}"`] : normalizedArgs;
  const result = spawnSync(executable, spawnArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: isWindowsShim,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: cleanEnv,
    ...options,
  });
  assert.equal(result.error, undefined, `${command} ${args.join(' ')} failed with error: ${result.error?.message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function resolvePnpmCommand() {
  if (process.platform !== 'win32') return 'pnpm';
  const result = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: cleanEnv });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `where.exe pnpm failed\n${result.stderr}`);
  const commands = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(commands.length > 0, 'where.exe pnpm returned no executable path');
  return commands.find((command) => /\.exe$/i.test(command)) ?? commands[0];
}
async function waitForRemovalReport(filename) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = JSON.parse(await readFile(filename, 'utf8'));
    if (report.status !== 'pending') return report;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for uninstall worker report: ${filename}`);
}

function readAdminUserId(filename) {
  const store = SqliteStore.open(filename);
  try {
    return store.upsertUser('admin', 'isolated-package-test-password').id;
  } finally {
    store.close();
  }
}

const testTraefikBinary = process.env.BRC_TRAEFIK_TEST_BINARY;

async function stageTraefikTestBinary(dataRoot) {
  assert.ok(testTraefikBinary, 'Set BRC_TRAEFIK_TEST_BINARY to the official local Traefik v3.7+ executable.');
  const result = spawnSync(testTraefikBinary, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: cleanEnv });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const version = result.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, result.stdout);
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 3 || (major === 3 && minor >= 7), `Traefik ${version} is older than v3.7.`);
  const versionDir = path.join(dataRoot, 'traefik', 'versions', version);
  await mkdir(versionDir, { recursive: true });
  await copyFile(testTraefikBinary, path.join(versionDir, 'traefik.exe'));
  await writeFile(
    path.join(dataRoot, 'traefik', 'versions.json'),
    `${JSON.stringify({ version: 1, current: version, previous: null })}\n`,
  );
}
async function updateAndStopBrc(dataRoot, root, bin, env, updatedPackage) {
  const dataMarker = path.join(dataRoot, 'data', 'private.sqlite');
  await mkdir(path.dirname(dataMarker), { recursive: true });
  await writeFile(dataMarker, 'isolated test database');
  const relayDatabase = path.join(dataRoot, 'data', 'relay.sqlite');
  const userIdBefore = existsSync(relayDatabase) ? readAdminUserId(relayDatabase) : null;
  run(pnpmCommand, ['add', '--global', '--offline', updatedPackage.tarball], { cwd: root, env });
  const packages = run(pnpmCommand, ['list', '--global', '--depth', '-1', '--json'], { cwd: root, env });
  assert.ok(packages.includes('@inoceanlee/brc'));
  assert.ok(packages.includes(updatedPackage.version), `global update did not install ${updatedPackage.version}: ${packages}`);
  assert.equal(await readFile(dataMarker, 'utf8'), 'isolated test database');
  if (userIdBefore !== null) {
    assert.equal(readAdminUserId(relayDatabase), userIdBefore, 'Updating the global CLI package must preserve the Relay user ID.');
  }
  const status = run(bin, ['status'], { cwd: root, env });
  assert.match(status, /relay:/);
  run(bin, ['stop'], { cwd: root, env });
}
const pnpmCommand = resolvePnpmCommand();

async function makePackageFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  if (process.env.BRC_PACKAGE_TARBALL) {
    assert.ok(process.env.BRC_PACKAGE_UPDATED_TARBALL, 'Set BRC_PACKAGE_UPDATED_TARBALL with a next-version package tarball.');
    return {
      root,
      tarball: path.resolve(process.env.BRC_PACKAGE_TARBALL),
      updatedTarball: path.resolve(process.env.BRC_PACKAGE_UPDATED_TARBALL),
    };
  }
  throw new Error('Package archives are missing. Run pnpm test:package to build and verify both archives.');
}

test('single package tarball is complete, self-contained, and globally installable', { timeout: 180_000 }, async (t) => {
  const { root, tarball, updatedTarball } = await makePackageFixture(t);
  for (const file of [tarball, updatedTarball]) {
    const handle = await open(file, 'r');
    try {
      const header = Buffer.alloc(10);
      await handle.read(header, 0, 10, 0);
      assert.equal(header[0], 0x1f);
      assert.equal(header[1], 0x8b);
      assert.equal(header[8], 2, 'npm package must use gzip maximum compression level (9)');
    } finally {
      await handle.close();
    }
  }
  const names = run('tar', ['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
  const files = new Set(names);

  for (const name of requiredFiles) {
    assert.ok(files.has(name), `tarball is missing ${name}`);
  }
  // All root-level Markdown documents are included without maintaining a second file list.
  for (const name of (await readdir(repoRoot)).filter((filename) => filename.endsWith('.md'))) {
    if ((await stat(path.join(repoRoot, name))).isFile()) {
      assert.ok(files.has('package/' + name), `tarball is missing ${name}`);
    }
  }
  for (const name of names) {
    assert.ok(!forbiddenFiles.some((pattern) => pattern.test(name)), `tarball contains excluded path ${name}`);
  }
  assert.ok(!names.some((name) => name.startsWith('package/deploy/traefik/') && /\.exe$/i.test(name)));

  const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
  const updatedManifest = JSON.parse(run('tar', ['-xOf', updatedTarball, 'package/package.json']));
  const bundledShared = JSON.parse(run('tar', ['-xOf', tarball, 'package/node_modules/brc-shared/package.json']));
  const sourceCli = JSON.parse(await readFile(path.join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  assert.equal(manifest.version, sourceCli.version, 'published product version must come from the CLI manifest');
  assert.equal(bundledShared.version, manifest.version, 'bundled Shared version must follow the product version');
  assert.equal(manifest.dependencies['brc-shared'], manifest.version);
  const version = manifest.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(version, `Expected a stable package version, got ${manifest.version}`);
  const nextVersion = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
  assert.equal(updatedManifest.name, manifest.name);
  assert.equal(updatedManifest.version, nextVersion);
  const updatedPackage = { tarball: updatedTarball, version: updatedManifest.version };
  assert.equal(manifest.name, '@inoceanlee/brc');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.bin?.brc, 'dist/cli.js');
  assert.ok(Object.values(manifest.dependencies ?? {}).every((value) => !value.startsWith('workspace:')));
  const readme = run('tar', ['-xOf', tarball, 'package/README.md']);
  assert.match(readme, /pnpm add -g @inoceanlee\/brc/);
  assert.match(readme, /pnpm up -g @inoceanlee\/brc --latest/);
  assert.match(readme, /brc uninstall/);
  assert.match(readme, /pnpm remove -g @inoceanlee\/brc/);
  assert.match(readme, /\[简体中文\]\(README_zh\.md\)/);
  const chineseReadme = run('tar', ['-xOf', tarball, 'package/README_zh.md']);
  assert.match(chineseReadme, /\[English\]\(README\.md\)/);
  assert.match(readme, /\[SECURITY\.md\]\(SECURITY\.md\)/);
  assert.match(readme, /\[NOTICE\]\(NOTICE\)/);

  const inspectionDir = path.join(root, 'inspection');
  const extractedPackage = path.join(inspectionDir, 'package');
  const distFiles = names.filter((name) => name.startsWith('package/dist/') && (name.endsWith('.js') || name === 'package/dist/native/win32-x64/brc-process.exe'));
  await mkdir(inspectionDir);
  run('tar', ['-xzf', tarball, '-C', inspectionDir, ...distFiles]);
  if (process.platform === 'win32') {
    const native = path.join(extractedPackage, 'dist', 'native', 'win32-x64', 'brc-process.exe');
    const bytes = await readFile(native);
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
    const response = JSON.parse(run(native, ['inspect', String(process.pid)]));
    assert.equal(response.processes[0].status, 'found');
    assert.equal(response.processes[0].pid, process.pid);
  }
  await writeFile(path.join(extractedPackage, 'package.json'), `${JSON.stringify(manifest)}\n`);
  run('tar', ['-xzf', tarball, '-C', inspectionDir, 'package/node_modules'], { timeout: 120_000 });
  assert.match(run(process.execPath, [path.join(repoRoot, 'tests', 'brc-package-runtime-smoke.mjs'), extractedPackage], { cwd: root, timeout: 120_000 }), /RUNTIME_SMOKE_PASS/);
  if (process.platform !== 'win32') {
    const cliMode = (await stat(path.join(extractedPackage, 'dist/cli.js'))).mode;
    assert.notEqual(cliMode & 0o111, 0, 'CLI bin must retain executable permissions');
  }
  const servicesUrl = pathToFileURL(path.join(extractedPackage, 'dist', 'lifecycle', 'services.js')).href;
  const settingsUrl = pathToFileURL(path.join(extractedPackage, 'dist', 'config', 'settings.js')).href;
  const dataRoot = path.join(root, 'brc-data');
  const serviceEntries = JSON.parse(run(process.execPath, [
    '--input-type=module',
    '-e',
    `
import { createDefaultServices } from ${JSON.stringify(servicesUrl)};
import { DEFAULT_SETTINGS } from ${JSON.stringify(settingsUrl)};
import path from 'node:path';
const root = ${JSON.stringify(dataRoot)};
const paths = Object.fromEntries(['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'].map((name) => [name, path.join(root, name)]));
const services = createDefaultServices(paths, DEFAULT_SETTINGS, {});
console.log(JSON.stringify(services.map(({ name, entrypoint, cwd, env }) => ({ name, entrypoint, cwd, productVersion: env.BRC_PRODUCT_VERSION }))));
`,
  ], { cwd: root }));
  assert.deepEqual(serviceEntries, [
    { name: 'relay', entrypoint: path.join(extractedPackage, 'dist', 'services', 'relay', 'cli.js'), cwd: extractedPackage, productVersion: manifest.version },
    { name: 'traefik', entrypoint: path.join(extractedPackage, 'dist', 'cli.js'), cwd: extractedPackage, productVersion: manifest.version },
    { name: 'agent', entrypoint: path.join(extractedPackage, 'dist', 'services', 'agent', 'cli.js'), cwd: extractedPackage, productVersion: manifest.version },
  ]);

  const isolatedHome = path.join(root, 'pnpm-home');
  const isolatedStore = path.join(root, 'pnpm-store');
  const isolatedCache = path.join(root, 'pnpm-cache');
  const isolatedState = path.join(root, 'pnpm-state');
  const isolatedPath = path.join(root, 'path');
  const bin = path.join(isolatedPath, process.platform === 'win32' ? 'brc.cmd' : 'brc');
  const powershellShim = path.join(isolatedPath, 'brc.ps1');
  const installDir = path.join(root, 'global-install');
  const env = {
    ...cleanEnv,
    PNPM_HOME: isolatedHome,
    PNPM_CONFIG_STORE_DIR: isolatedStore,
    PNPM_CONFIG_STATE_DIR: isolatedState,
    PNPM_CONFIG_CACHE_DIR: isolatedCache,
    PNPM_CONFIG_GLOBAL_DIR: installDir,
    PNPM_CONFIG_GLOBAL_BIN_DIR: isolatedPath,
    PATH: `${isolatedPath}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const [relayPort, proxyPort, healthPort] = await allocateServicePorts();
  const isolatedEnv = {
    ...env,
    BRC_DATA_ROOT: path.join(root, 'brc-data'),
    BRC_RELAY_PORT: String(relayPort),
    BRC_TRAEFIK_PORT: String(proxyPort),
    BRC_TRAEFIK_HEALTH_PORT: String(healthPort),
    PATH: `${isolatedPath}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  await Promise.all([isolatedHome, isolatedStore, isolatedCache, isolatedState, isolatedPath, installDir].map((directory) => mkdir(directory, { recursive: true })));
  for (const [setting, expected] of [
    ['global-dir', installDir],
    ['global-bin-dir', isolatedPath],
    ['store-dir', isolatedStore],
    ['state-dir', isolatedState],
    ['cache-dir', isolatedCache],
  ]) {
    const actual = run(pnpmCommand, ['config', 'get', setting], { cwd: root, env });
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(expected).toLowerCase(), `pnpm ${setting} must stay isolated`);
  }
  run(pnpmCommand, ['add', '--global', '--offline', tarball], { cwd: root, env });

  const help = run(bin, ['help'], { cwd: root, env: isolatedEnv });
  const wrapper = await readFile(bin, 'utf8');
  assert.match(help, /BRC unified CLI/, `brc.cmd did not print help; wrapper contents:\n${wrapper}`);

  const status = run(bin, ['status'], {
    cwd: root,
    env: { ...isolatedEnv, BRC_DATA_ROOT: path.join(root, 'brc-data') },
  });
  assert.match(status, /relay:/);
  assert.match(status, /agent:/);
  assert.match(status, /traefik:/);
  const storeMarker = path.join(isolatedStore, 'brc-preserve-marker');
  await writeFile(storeMarker, 'shared pnpm data');
  if (process.platform === 'win32') {
    assert.ok(testTraefikBinary, 'Set BRC_TRAEFIK_TEST_BINARY to the official local Traefik v3.7+ executable.');
    const shells = process.env.BRC_PACKAGE_SHELL ? [process.env.BRC_PACKAGE_SHELL] : ['cmd', 'powershell'];
    assert.ok(shells.every((shell) => shell === 'cmd' || shell === 'powershell'), 'BRC_PACKAGE_SHELL must be cmd or powershell.');
    const relayCli = path.join(repoRoot, 'packages', 'relay', 'dist', 'cli.js');
    for (const shell of shells) {
      await stageTraefikTestBinary(dataRoot);
      // status above created this root; setup must not fabricate a missing identity here.
      run(process.execPath, [relayCli, '--initialize'], {
        cwd: root,
        env: { ...isolatedEnv, BRC_DB: path.join(dataRoot, 'data', 'relay.sqlite') },
      });
      run(bin, ['setup'], { cwd: root, env: isolatedEnv });
      await updateAndStopBrc(dataRoot, root, bin, isolatedEnv, updatedPackage);
      const command = shell === 'cmd'
        ? run(bin, ['uninstall', '--yes'], { cwd: root, env: isolatedEnv })
        : run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          powershellShim,
          'uninstall',
          '--yes',
        ], { cwd: root, env: isolatedEnv });
      const reportMatch = command.match(/completion report: (.+)/);
      assert.ok(reportMatch, `${shell} uninstall did not report its completion file:\n${command}`);
      const removalReport = await waitForRemovalReport(reportMatch[1].trim());

      assert.equal(removalReport.status, 'completed', JSON.stringify(removalReport));
      await assert.rejects(stat(dataRoot), { code: 'ENOENT' });
      await assert.rejects(stat(bin), { code: 'ENOENT' });
      await assert.rejects(stat(powershellShim), { code: 'ENOENT' });
      assert.equal(run(pnpmCommand, ['list', '--global', '--depth', '-1', '--json'], { cwd: root, env }).includes('@inoceanlee/brc'), false);
      assert.equal(await readFile(storeMarker, 'utf8'), 'shared pnpm data');

      if (shell === 'cmd' && shells.includes('powershell')) run(pnpmCommand, ['add', '--global', '--offline', tarball], { cwd: root, env });
    }
  } else {
    await updateAndStopBrc(dataRoot, root, bin, isolatedEnv, updatedPackage);
    const output = run(bin, ['uninstall', '--yes'], { cwd: root, env: isolatedEnv });
    assert.match(output, /BRC data removed/);
    await assert.rejects(stat(dataRoot), { code: 'ENOENT' });
    await assert.rejects(stat(bin), { code: 'ENOENT' });
    assert.equal(await readFile(storeMarker, 'utf8'), 'shared pnpm data');
  }
});
