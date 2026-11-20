import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { cp, copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import net, { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessManager } from '../packages/cli/dist/adapters/process/controller.js';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';
import { createDefaultServices } from '../packages/cli/dist/adapters/process/specs.js';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { PlatformEnvironment } from '../packages/cli/dist/config/platform-environment.js';
import { LifecycleLock as LifecycleLockImpl } from '../packages/cli/dist/adapters/storage/lock.js';
import { LockStore } from '../packages/cli/dist/adapters/storage/lock-store.js';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { TraefikManager } from '../packages/cli/dist/adapters/traefik/manager.js';
import { runManagedTraefikService, waitForConfigGeneration } from '../packages/cli/dist/adapters/traefik/runtime.js';
import { createDiagnosticsRuntime } from '../packages/shared/dist/diagnostics/runtime.js';
import { renderConfig } from '../packages/cli/dist/core/traefik/rules.js';
import { TraefikInput } from '../packages/cli/dist/adapters/traefik/input.js';
import { TraefikOutput } from '../packages/cli/dist/adapters/traefik/output.js';

function LifecycleLock(paths, options) {
  return new LifecycleLockImpl(paths, new LockStore(paths), options);
}

const API_URL = 'https://api.github.com/repos/traefik/traefik/releases/latest';
const TEST_BINARY = process.env.BRC_TRAEFIK_TEST_BINARY;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const yaml = require('js-yaml');

function paths(root) {
  return {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  };
}

async function makeRoot(t, { cleanup = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-'));
  const brcPaths = paths(root);
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths: brcPaths };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.contents);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
function makeTarGz(entries) {
  const { gzipSync } = require('node:zlib');
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    header.write('0001000\0', 108, 8, 'ascii');
    header.write('0001000\0', 116, 8, 'ascii');
    const data = Buffer.from(entry.contents || '');
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
    header.write('14000000000 ', 136, 12, 'ascii');
    header.write(entry.typeflag || '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(0x20, 148, 156);
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    header.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data);
      const remainder = data.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}


const traefikTarget = new PlatformEnvironment().resolveTraefikTarget();
const traefikBinary = traefikTarget.executableName;
const traefikAssetSuffix = `_${traefikTarget.platform}_${traefikTarget.arch}.${traefikTarget.archiveExt}`;

function makeArchive(entries) {
  return traefikTarget.archiveExt === 'zip' ? makeZip(entries) : makeTarGz(entries);
}

function makeRelease(version, options = {}) {
  const filename = `traefik_v${version}${traefikAssetSuffix}`;
  const checksumFilename = `traefik_v${version}_checksums.txt`;
  const archive = options.archive ?? makeArchive([{ name: traefikBinary, contents: Buffer.from(`binary-${version}`) }]);
  const digest = options.checksum ?? createHash('sha256').update(archive).digest('hex');
  const release = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: checksumFilename, browser_download_url: `https://github.com/traefik/traefik/releases/download/v${version}/${checksumFilename}` },
      { name: filename, browser_download_url: `https://github.com/traefik/traefik/releases/download/v${version}/${filename}` },
    ],
  };
  const state = { release, archive, checksumText: `${digest}  ${filename}\n`, interrupted: false, requests: [] };
  state.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    state.requests.push(url.href);
    if (url.href === API_URL) {
      return new Response(JSON.stringify(state.release), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const checksumAsset = state.release.assets.find((asset) => asset.name.endsWith('_checksums.txt'));
    const archiveAsset = state.release.assets.find((asset) => asset.name.endsWith(traefikAssetSuffix));
    if (url.href === checksumAsset?.browser_download_url) return new Response(state.checksumText, { status: 200 });
    if (url.href === archiveAsset?.browser_download_url) {
      if (state.interrupted) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(state.archive.subarray(0, Math.max(1, Math.floor(state.archive.length / 2))));
            controller.error(new Error('synthetic interrupted download'));
          },
        }), { status: 200 });
      }
      return new Response(state.archive, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  state.setVersion = (nextVersion, nextOptions = {}) => {
    const next = makeRelease(nextVersion, nextOptions);
    state.release = next.release;
    state.archive = next.archive;
    state.checksumText = next.checksumText;
    state.interrupted = false;
  };
  return state;
}

function settingsFor(env = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.services.relayPort = Number(env.BRC_RELAY_PORT ?? 13000);
  settings.services.proxyPort = Number(env.BRC_TRAEFIK_PORT ?? 13001);
  settings.services.healthPort = Number(env.BRC_TRAEFIK_HEALTH_PORT ?? 13002);
  return settings;
}

function makeLifecycle() {
  const state = {
    service: 'stopped',
    events: [],
    lockHeld: false,
    failNextStart: false,
    failNextStop: false,
    beforeLock: undefined,
  };
  const operations = {
    start: async () => {
      state.events.push('start');
      if (state.failNextStart) {
        state.failNextStart = false;
        throw new Error('candidate service failed to start');
      }
      state.service = 'running';
    },
    stop: async () => {
      state.events.push('stop');
      if (state.failNextStop) {
        state.failNextStop = false;
        throw new Error('candidate service failed to stop');
      }
      state.service = 'stopped';
    },
    restart: async () => { state.events.push('restart'); state.service = 'running'; },
  };
  return {
    state,
    status: async () => [{ name: 'traefik', state: state.service, pid: null, detail: '' }],
    withLock: async (operation) => {
      assert.equal(state.lockHeld, false);
      state.lockHeld = true;
      try {
        await state.beforeLock?.();
        state.beforeLock = undefined;
        return await operation(operations);
      } finally {
        state.lockHeld = false;
      }
    },
  };
}
test('a failed service stop restores the previous Traefik version and service', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const lifecycle = makeLifecycle();
  const manager = makeManager(brcPaths, release, { lifecycle });
  await manager.setup();

  lifecycle.state.service = 'running';
  lifecycle.state.failNextStop = true;
  release.setVersion('3.7.17');
  await assert.rejects(manager.update(), /failed to stop/i);

  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.deepEqual(lifecycle.state.events, ['stop', 'start']);
  assert.equal(lifecycle.state.service, 'running');
});

test('Traefik update preserves the active Relay target with a pending port change', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const lifecycle = makeLifecycle();
  const settings = settingsFor();
  const relayPort = settings.services.relayPort;
  const manager = makeManager(brcPaths, release, { lifecycle, settings });
  await manager.setup();

  lifecycle.state.service = 'running';
  settings.services.relayPort = relayPort + 1;
  release.setVersion('3.7.17');
  await manager.update();

  const dynamic = yaml.safeLoad(await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8'));
  assert.equal(dynamic.http.services.backend.loadBalancer.servers[0].url, `http://127.0.0.1:${relayPort}`);
});

test('Traefik update keeps a pending proxy port until the Agent can restart', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const healthServer = createServer(async (_request, response) => {
    const dynamic = await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8');
    const configGeneration = dynamic.match(/X-BRC-Config-Generation:\s*"?([0-9a-f-]{36})"?/i)?.[1];
    if (!configGeneration) {
      response.writeHead(500).end('missing config generation');
      return;
    }
    response.writeHead(200, { 'X-BRC-Config-Generation': configGeneration }).end('ok');
  });
  const healthPort = await listen(healthServer);
  t.after(() => new Promise((resolve) => healthServer.close(resolve)));

  const release = makeRelease('3.7.16');
  const lifecycle = makeLifecycle();
  const settings = settingsFor({ BRC_TRAEFIK_HEALTH_PORT: String(healthPort) });
  const activeProxyPort = settings.services.proxyPort;
  const manager = makeManager(brcPaths, release, { lifecycle, settings });
  await manager.setup();

  lifecycle.state.service = 'running';
  const previous = structuredClone(settings);
  settings.services.proxyPort++;
  await manager.writeConfig(previous);
  release.setVersion('3.7.17');
  await manager.update();

  const staticConfig = await readFile(path.join(brcPaths.traefik, 'config', 'traefik.yml'), 'utf8');
  assert.match(staticConfig, new RegExp(`127\\.0\\.0\\.1:${activeProxyPort}`));
  assert.doesNotMatch(staticConfig, new RegExp(`127\\.0\\.0\\.1:${settings.services.proxyPort}`));
});

test('update rejects an installed-version change while waiting for the lifecycle lock', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const lifecycle = makeLifecycle();
  const manager = makeManager(brcPaths, release, { lifecycle });
  await manager.setup();

  lifecycle.state.beforeLock = async () => {
    await writeFile(path.join(brcPaths.traefik, 'versions.json'), `${JSON.stringify({
      version: 1,
      current: '3.7.15',
      previous: null,
    })}\n`);
  };
  await assert.rejects(manager.update(), /changed|retry/i);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.15', previous: null });
});

function makeManager(paths, release, options = {}) {
  const env = options.env ?? { BRC_RELAY_PORT: '13000', BRC_TRAEFIK_PORT: '13001', BRC_TRAEFIK_HEALTH_PORT: '13002' };
  const lifecycle = options.lifecycle ?? makeLifecycle();
  const { env: _env, lifecycle: _lifecycle, settings: customSettings, ...managerOptions } = options;
  return new TraefikManager(paths, customSettings ?? settingsFor(env), lifecycle, {
    releaseApiUrl: API_URL,
    fetch: release.fetch,
    verifyExecutable: async (filename, expectedVersion) => {
      assert.equal(await readFile(filename, 'utf8'), `binary-${expectedVersion}`);
    },
    healthCheck: async () => { },
    ...managerOptions,
  });
}

async function manifest(paths) {
  return JSON.parse(await readFile(path.join(paths.traefik, 'versions.json'), 'utf8'));
}

async function installedExecutable(paths, version) {
  return readFile(path.join(paths.traefik, 'versions', version, traefikBinary), 'utf8');
}

test('setup reports operation stages and download failures without changing the error', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const events = [];
  const manager = makeManager(brcPaths, release, { reporter: (event) => events.push(event) });
  await manager.setup();
  assert.ok(events.some((event) => event.operation === 'setup' && event.stage === 'release' && event.status === 'completed'));
  assert.ok(events.some((event) => event.operation === 'setup' && event.stage === 'stage' && event.status === 'completed'));
  release.setVersion('3.7.17', { checksum: '0'.repeat(64) });
  await assert.rejects(manager.update(), /checksum/i);
  assert.ok(events.some((event) => event.operation === 'update' && event.stage === 'verify' && event.status === 'failed'));
});

test('missing deployment templates leave the installed version and both configurations unchanged', async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  await makeManager(brcPaths, release).setup();
  const files = [
    path.join(brcPaths.traefik, 'versions', '3.7.16', traefikBinary),
    path.join(brcPaths.traefik, 'versions.json'),
    path.join(brcPaths.traefik, 'config', 'dynamic.yml'),
    path.join(brcPaths.traefik, 'config', 'traefik.yml'),
  ];
  const before = await Promise.all(files.map((file) => readFile(file)));

  // Copy compiled code without deployment templates; dependencies remain read-only.
  const cliRoot = fileURLToPath(new URL('../packages/cli/', import.meta.url));
  const isolatedPackage = path.join(root, 'sandbox', 'package');
  await mkdir(isolatedPackage, { recursive: true });
  await cp(path.join(cliRoot, 'dist'), path.join(isolatedPackage, 'dist'), { recursive: true });
  await copyFile(path.join(cliRoot, 'package.json'), path.join(isolatedPackage, 'package.json'));
  const modules = path.join(isolatedPackage, 'node_modules');
  await mkdir(modules);
  let unzipperRoot = path.dirname(require.resolve('unzipper'));
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(unzipperRoot, 'package.json'), 'utf8'));
      if (packageJson.name === 'unzipper') break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(unzipperRoot);
    if (parent === unzipperRoot) throw new Error('Cannot locate the installed unzipper package.');
    unzipperRoot = parent;
  }
  await symlink(unzipperRoot, path.join(modules, 'unzipper'), 'junction');
  await symlink(path.resolve(cliRoot, '../shared'), path.join(modules, 'brc-shared'), 'junction');
  const { TraefikManager: IsolatedManager } = await import(pathToFileURL(path.join(isolatedPackage, 'dist', 'traefik', 'manager.js')).href);
  const manager = new IsolatedManager(brcPaths, settingsFor(), makeLifecycle(), {
    fetch: release.fetch,
    verifyExecutable: async () => { },
    healthCheck: async () => { },
  });
  await assert.rejects(manager.writeConfig(), /templates are missing/i);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
});

test('unsafe archives and checksum failures preserve installed files and both configurations', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();
  const files = [
    path.join(brcPaths.traefik, 'versions', '3.7.16', traefikBinary),
    path.join(brcPaths.traefik, 'versions.json'),
    path.join(brcPaths.traefik, 'config', 'dynamic.yml'),
    path.join(brcPaths.traefik, 'config', 'traefik.yml'),
  ];
  const before = await Promise.all(files.map((file) => readFile(file)));
  for (const options of [
    { checksum: '0'.repeat(64) },
    { archive: makeArchive([{ name: traefikBinary, contents: Buffer.from('binary') }, { name: '../escape', contents: Buffer.from('bad') }]) },
    { archive: makeArchive([{ name: traefikBinary, contents: Buffer.from('binary') }, { name: traefikBinary, contents: Buffer.from('other') }]) },
  ]) {
    release.setVersion('3.7.17', options);
    await assert.rejects(manager.update());
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
  }
});

test('pure rendering uses independent static and dynamic settings', () => {
  const dynamicSettings = settingsFor({ BRC_RELAY_PORT: '14000' });
  const staticSettings = settingsFor({ BRC_TRAEFIK_PORT: '14001', BRC_TRAEFIK_HEALTH_PORT: '14002' });
  const result = renderConfig({
    templates: { dynamicConfig: '@@BRC_RELAY_URL@@ @@BRC_RATE_AVERAGE@@', staticConfig: '@@BRC_WEB_ADDRESS@@ @@BRC_HEALTH_ADDRESS@@ @@BRC_DYNAMIC_FILE@@' },
    dynamicSettings, staticSettings, dynamicPath: 'config/dynamic.yml', generation: 'generation',
  });
  assert.match(result.dynamicConfig, /127\.0\.0\.1:14000/);
  assert.match(result.staticConfig, /127\.0\.0\.1:14001/);
  assert.match(result.staticConfig, /127\.0\.0\.1:14002/);
});

test('failed release acquisition leaves installed executable and configuration unchanged', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();
  const files = [
    path.join(brcPaths.traefik, 'versions', '3.7.16', traefikBinary),
    path.join(brcPaths.traefik, 'versions.json'),
    path.join(brcPaths.traefik, 'config', 'dynamic.yml'),
    path.join(brcPaths.traefik, 'config', 'traefik.yml'),
  ];
  const before = await Promise.all(files.map((file) => readFile(file)));
  for (const status of [403, 429]) {
    const blocked = makeManager(brcPaths, release, {
      fetch: async () => new Response('', { status, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    await assert.rejects(blocked.update());
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
  }
  release.setVersion('3.7.17', { archive: Buffer.from('not a zip') });
  await assert.rejects(manager.update());
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
});


test('configuration rejects degraded ownership even when PID reuse is claimed', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  let detail = 'Recorded PID was reused; process identity changed.';
  const lifecycle = makeLifecycle();
  lifecycle.status = async () => [{ name: 'traefik', state: 'degraded', pid: 123, detail }];
  const manager = makeManager(brcPaths, makeRelease('3.7.16'), { lifecycle });
  await assert.rejects(manager.writeConfig(), /Cannot apply Traefik configuration/);
  detail = 'Cannot verify process identity; refusing process control.';
  await assert.rejects(manager.writeConfig(), /Cannot apply Traefik configuration/);
});
test('configuration uses BrcSettings and keeps a single public proxy router', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.proxy.rate.average = 7;
  settings.proxy.rate.period = '2s';
  settings.proxy.rate.burst = 19;
  settings.proxy.concurrent = 11;
  const manager = makeManager(brcPaths, makeRelease('3.7.16'), { settings });

  await manager.writeConfig();

  const configDirectory = path.join(brcPaths.traefik, 'config');
  const dynamic = yaml.safeLoad(await readFile(path.join(configDirectory, 'dynamic.yml'), 'utf8'));
  const staticConfig = yaml.safeLoad(await readFile(path.join(configDirectory, 'traefik.yml'), 'utf8'));
  assert.equal(dynamic.http.middlewares.rate.rateLimit.average, 7);
  assert.equal(dynamic.http.middlewares.rate.rateLimit.period, '2s');
  assert.equal(dynamic.http.middlewares.rate.rateLimit.burst, 19);
  assert.equal(dynamic.http.middlewares.flight.inFlightReq.amount, 11);
  assert.equal(dynamic.http.middlewares.force.headers.customRequestHeaders['X-BRC-Limit-Key'], 'global-v1');
  assert.equal(Object.values(dynamic.http.routers).filter((router) => router.entryPoints.includes('web')).length, 1);
  assert.deepEqual(dynamic.http.routers.health?.entryPoints, ['health']);
  assert.equal(dynamic.http.routers.health?.rule, 'Path(`/ping`)');
  assert.equal(dynamic.http.routers.health?.service, 'ping@internal');
  assert.equal(dynamic.http.routers.health?.middlewares?.[0], 'config-generation');
  assert.match(dynamic.http.middlewares['config-generation']?.headers?.customResponseHeaders?.['X-BRC-Config-Generation'] ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(staticConfig.ping.manualRouting, true);
  assert.equal(staticConfig.entryPoints.health.address, `127.0.0.1:${settings.services.healthPort}`);
});

test('config changes write Traefik limits under the shared lifecycle lock', async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t);
  const lifecycleLock = new LifecycleLock(brcPaths);
  const processes = {
    start: async () => { },
    stop: async () => { },
    status: async () => ({ name: 'traefik', state: 'stopped', pid: null, detail: 'stopped' }),
    check: async () => ({ ready: true, detail: 'healthy' }),
  };
  const serviceManager = new ServiceManager(brcPaths, [], processes, processes, lifecycleLock);
  const traefikManager = new TraefikManager(brcPaths, DEFAULT_SETTINGS, serviceManager);
  const settingsManager = await SettingsManager.load(brcPaths, { BRC_DATA_ROOT: root }, {
    lock: lifecycleLock,
    apply: async (settings) => traefikManager.writeConfigWithLockHeld(settings),
  });

  await settingsManager.set('proxy.rate.average', 17);

  const dynamic = await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8');
  assert.match(dynamic, /average: 17/);
});

test('Traefik writes the latest settings while holding the shared lifecycle lock', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const lifecycleLock = new LifecycleLock(brcPaths);
  const processes = {
    start: async () => { },
    stop: async () => { },
    status: async () => ({ name: 'traefik', state: 'stopped', pid: null, detail: 'stopped' }),
    check: async () => ({ ready: true, detail: 'healthy' }),
  };
  const serviceManager = new ServiceManager(brcPaths, [], processes, processes, lifecycleLock);
  const latest = structuredClone(DEFAULT_SETTINGS);
  latest.proxy.rate.average = 23;
  const manager = new TraefikManager(brcPaths, DEFAULT_SETTINGS, serviceManager, {
    loadSettings: async () => {
      await assert.rejects(lifecycleLock.runExclusive(async () => { }), /cannot be acquired recursively/i);
      return latest;
    },
  });

  await manager.writeConfig();

  const dynamic = await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8');
  assert.match(dynamic, /average: 23/);
});

test('setup installs verified stable release once and retains its executable', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);

  await manager.setup();
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  const downloadCount = release.requests.filter((url) => url.endsWith(traefikAssetSuffix)).length;

  release.setVersion('3.7.17');
  await manager.setup();
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(release.requests.filter((url) => url.endsWith(traefikAssetSuffix)).length, downloadCount);
});

test('an interrupted update leaves the current executable and version metadata unchanged', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();

  release.setVersion('3.7.17');
  release.interrupted = true;
  await assert.rejects(manager.update());
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.17', traefikBinary)));
});

test('a checksum mismatch cannot replace an installed release', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();

  release.setVersion('3.7.17', { checksum: '0'.repeat(64) });
  await assert.rejects(manager.update(), /checksum/i);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
});

test('a ZIP entry that escapes staging is rejected before it can write outside the version directory', async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16', {
    archive: makeArchive([
      { name: traefikBinary, contents: Buffer.from('binary-3.7.16') },
      { name: '../../outside.exe', contents: Buffer.from('escape') },
    ]),
  });
  const manager = makeManager(brcPaths, release);

  await assert.rejects(manager.setup(), /zip|archive|path|entry/i);
  await assert.rejects(stat(path.join(root, 'outside.exe')));
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.16', traefikBinary)));
});

test('a candidate that fails health validation leaves the old release available for rollback', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  let rejectNewRelease = false;
  const manager = makeManager(brcPaths, release, {
    healthCheck: async (_filename, candidateVersion) => {
      if (rejectNewRelease && candidateVersion === '3.7.17') throw new Error('candidate health check failed');
    },
  });
  await manager.setup();

  release.setVersion('3.7.17');
  rejectNewRelease = true;
  await assert.rejects(manager.update(), /health check failed/i);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.17')));
});

test('a failed service restart restores the prior Traefik version under the shared lock', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const lifecycle = makeLifecycle();
  const manager = makeManager(brcPaths, release, { lifecycle });
  await manager.setup();

  lifecycle.state.service = 'running';
  release.setVersion('3.7.17');
  const fetch = release.fetch;
  release.fetch = async (...args) => {
    assert.equal(lifecycle.state.lockHeld, false, 'release downloads must stay outside the lifecycle lock');
    return fetch(...args);
  };
  lifecycle.state.failNextStart = true;
  await assert.rejects(manager.update(), /candidate service failed to start/i);

  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  assert.deepEqual(lifecycle.state.events, ['stop', 'start', 'start']);
  assert.equal(lifecycle.state.service, 'running');
});

test('concurrent setup calls share one validated installation', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);

  await Promise.all([manager.setup(), manager.setup(), manager.setup()]);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(release.requests.filter((url) => url === API_URL).length, 1);
  assert.equal(release.requests.filter((url) => url.endsWith(traefikAssetSuffix.slice(1))).length, 1);
});

test('service order keeps Relay behind Traefik and routes Agent traffic through the proxy', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const env = {
    BRC_RELAY_PORT: '13000',
    BRC_TRAEFIK_PORT: '13001',
    BRC_TRAEFIK_HEALTH_PORT: '13002',
  };
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    services: { ...DEFAULT_SETTINGS.services, relayPort: 13000, proxyPort: 13001, healthPort: 13002, publicUrl: 'https://brc.example.test' },
    logs: { ...DEFAULT_SETTINGS.logs, rotateMiB: 2 },
    runtime: { ...DEFAULT_SETTINGS.runtime, startupTimeoutMs: 12345, shutdownTimeoutMs: 6789 },
  };
  const services = createDefaultServices(brcPaths, settings, env);

  assert.deepEqual(services.map((service) => service.name), ['relay', 'traefik', 'agent']);
  assert.equal(services[0].env.PORT, '13000');
  assert.equal(services[0].env.PUBLIC_URL, 'https://brc.example.test');
  assert.equal(services[1].env.BRC_TRAEFIK_ROOT, brcPaths.traefik);
  assert.equal(services[1].env.BRC_DATA_ROOT, brcPaths.root);
  assert.equal(services[1].env.BRC_TRAEFIK_PORT, '13001');
  assert.equal(services[1].env.BRC_RUNTIME_STARTUP_TIMEOUT_MS, '12345');
  assert.equal(services[0].env.BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS, '6789');
  assert.equal(services[1].env.BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS, '6789');
  assert.equal(services[2].env.BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS, '6789');
  assert.equal(services[0].env.BRC_LOG_ROTATE_MIB, '2');
  assert.equal(services[1].env.BRC_LOG_ROTATE_MIB, '2');
  assert.equal(services[2].env.BRC_LOG_ROTATE_MIB, '2');
  assert.deepEqual(services[1].args, ['--run-traefik']);
  assert.equal(services[2].env.BRC_RELAY, 'http://127.0.0.1:13001');
});

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(servers.map((server) => listen(server)));
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  return ports;
}

function httpStatus(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: pathname,
      localAddress: options.localAddress,
      headers: options.headers,
      agent: false,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.setTimeout(5_000, () => req.destroy(new Error(`HTTP request timed out: ${pathname}`)));
    req.once('error', reject);
    req.end();
  });
}
function httpHeader(port, pathname, headerName) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: pathname,
      agent: false,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.headers[headerName.toLowerCase()]));
    });
    req.setTimeout(5_000, () => req.destroy(new Error(`HTTP request timed out: ${pathname}`)));
    req.once('error', reject);
    req.end();
  });
}
test('config apply rejects when Traefik keeps serving an older dynamic generation', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const health = createServer((_request, response) => {
    response.writeHead(200, { 'X-BRC-Config-Generation': 'stale' }).end();
  });
  const healthPort = await listen(health);
  t.after(() => new Promise((resolve, reject) => health.close((error) => error ? reject(error) : resolve())));

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.services.healthPort = healthPort;
  settings.runtime.startupTimeoutMs = 100;
  const lifecycle = makeLifecycle();
  lifecycle.state.service = 'running';
  const manager = makeManager(brcPaths, makeRelease('3.7.16'), { settings, lifecycle });

  await assert.rejects(manager.writeConfig(settings), /dynamic configuration.*timeout/i);
});

test('config-generation probe enforces total deadline while response keeps streaming', async (t) => {
  const health = createServer((_request, response) => {
    response.writeHead(200, { 'X-BRC-Config-Generation': 'stale' });
    response.write('x');
    const drip = setInterval(() => response.write('x'), 20);
    const finish = setTimeout(() => response.end(), 400);
    response.once('close', () => {
      clearInterval(drip);
      clearTimeout(finish);
    });
  });
  const healthPort = await listen(health);
  t.after(() => new Promise((resolve, reject) => health.close((error) => error ? reject(error) : resolve())));

  const startedAt = Date.now();
  await assert.rejects(waitForConfigGeneration([healthPort], 'current', 120), /dynamic configuration.*timeout/i);
  assert.ok(Date.now() - startedAt < 300, 'the complete probe must stay within its total deadline.');
});


async function websocketStatus(port, pathname = '/ws', headers = {}) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  const status = await new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WebSocket handshake timed out: ${pathname}`));
    }, 5_000);
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0));
    });
    socket.write([
      `GET ${pathname} HTTP/1.1`,
      'Host: test.invalid',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n'));
  });
  if (status !== 101) socket.destroy();
  return { status, socket };
}

const realTraefikSkip = TEST_BINARY ? false : 'Set BRC_TRAEFIK_TEST_BINARY to an official Traefik v3.7+ executable.';
test('managed Traefik health degrades on diagnostic log failure', { skip: realTraefikSkip, timeout: 30_000 }, async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t);
  const versionResult = spawnSync(TEST_BINARY, ['version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const version = versionResult.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version);
  const versionDir = path.join(brcPaths.traefik, 'versions', version);
  await mkdir(versionDir, { recursive: true });
  await copyFile(TEST_BINARY, path.join(versionDir, process.platform === 'win32' ? 'traefik.exe' : 'traefik'));
  await writeFile(path.join(brcPaths.traefik, 'versions.json'), JSON.stringify({ version: 1, current: version, previous: null }));
  const [relayPort, proxyPort, healthPort] = await reservePorts(3);
  const settings = settingsFor({ BRC_RELAY_PORT: String(relayPort), BRC_TRAEFIK_PORT: String(proxyPort), BRC_TRAEFIK_HEALTH_PORT: String(healthPort) });
  const manager = new TraefikManager(brcPaths, settings, makeLifecycle());
  await manager.writeConfig();
  const readyFile = path.join(root, 'control.json');
  const variables = {
    BRC_MANAGED_SERVICE: 'traefik', BRC_MANAGED_ID: 'test-traefik',
    BRC_TRAEFIK_ROOT: brcPaths.traefik, BRC_TRAEFIK_CONFIG_DIR: path.join(brcPaths.traefik, 'config'),
    BRC_TRAEFIK_HEALTH_PORT: String(healthPort), BRC_LOG_FILE: path.join(root, 'traefik.log'),
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const failure = new Error('diagnostic write failed');
  const diagnostics = createDiagnosticsRuntime({
    enabled: true, component: 'traefik',
    log: { async write() { throw failure; }, async flush() {} },
  });
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const running = runManagedTraefikService(settings, diagnostics, {
    controlServer: createServer(),
    controlIdentity: { token: 'test-control-token', readyFile, id: 'test-traefik', service: 'traefik' },
  });
  const outcome = running.then(() => undefined, (error) => error);
  try {
    let ready;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { ready = JSON.parse(await readFile(readyFile, 'utf8')); break; } catch { await sleep(50); }
    }
    assert.ok(ready, 'Traefik control server did not start');
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      health = await (await fetch(`http://127.0.0.1:${ready.port}/health`, {
        headers: { authorization: 'Bearer test-control-token' },
      })).json();
      if (health.state === 'degraded') break;
      await sleep(50);
    }
    assert.equal(health.state, 'degraded');
    assert.match(health.detail, /diagnostic write failed/);
    assert.equal(await httpStatus(healthPort, '/ping'), 200);
    const shutdown = await fetch(`http://127.0.0.1:${ready.port}/shutdown`, {
      method: 'POST', headers: { authorization: 'Bearer test-control-token' },
    });
    assert.equal(shutdown.status, 500);
    assert.match((await shutdown.json()).error.message, /diagnostic write failed/);
    assert.match(String(await outcome), /diagnostic write failed/);
    await assert.rejects(diagnostics.stop(), failure);
  } finally {
    if (process.env.BRC_TRAEFIK_ROOT === brcPaths.traefik) {
      const ready = await readFile(readyFile, 'utf8').then(JSON.parse).catch(() => undefined);
      if (ready) await fetch(`http://127.0.0.1:${ready.port}/shutdown`, {
        method: 'POST', headers: { authorization: 'Bearer test-control-token' },
      }).catch(() => undefined);
    }
  }
});
test('official Traefik routes all paths and shares global rate and in-flight limits', { skip: realTraefikSkip }, async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t, { cleanup: false });
  let backend;
  let serviceManager;
  const backendSockets = new Set();
  t.after(async () => {
    let stopError;
    if (serviceManager) {
      try { await serviceManager.stop(); } catch (error) { stopError = error; }
    }
    for (const socket of backendSockets) socket.destroy();
    if (backend?.listening) await new Promise((resolve) => backend.close(resolve));
    if (stopError) throw stopError;
    await rm(root, { recursive: true, force: true });
  });
  const versionResult = spawnSync(TEST_BINARY, ['version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const version = versionResult.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, versionResult.stdout);
  const versionDir = path.join(brcPaths.traefik, 'versions', version);
  await mkdir(versionDir, { recursive: true });
  const binaryPath = path.join(versionDir, traefikBinary);
  try {
    await link(TEST_BINARY, binaryPath);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EXDEV'].includes(error.code)) throw error;
    await copyFile(TEST_BINARY, binaryPath);
  }
  await writeFile(path.join(brcPaths.traefik, 'versions.json'), `${JSON.stringify({ version: 1, current: version, previous: null })}\n`);

  const events = [];
  let active = 0;
  let peak = 0;
  let webSockets = 0;
  backend = createServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    events.push({ path: req.url, host: req.headers.host, key: req.headers['x-brc-limit-key'], xff: req.headers['x-forwarded-for'] });
    res.once('close', () => { active--; });
    const delay = Number(new URL(req.url, 'http://localhost').searchParams.get('hold') ?? 0);
    setTimeout(() => { if (!res.destroyed) res.writeHead(204).end(); }, delay);
  });
  backend.on('connection', (socket) => {
    backendSockets.add(socket);
    socket.once('close', () => backendSockets.delete(socket));
  });
  backend.on('upgrade', (req, socket) => {
    active++;
    webSockets++;
    peak = Math.max(peak, active);
    events.push({ path: req.url, host: req.headers.host, key: req.headers['x-brc-limit-key'], xff: req.headers['x-forwarded-for'] });
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const release = () => { active--; webSockets--; };
    socket.once('close', release);
    socket.on('end', () => socket.end());
    socket.on('data', (data) => {
      if ((data[0] & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0]));
    });
  });
  const relayPort = await listen(backend);
  const [proxyPort, healthPort] = await reservePorts(2);
  const env = {
    BRC_RELAY_PORT: String(relayPort),
    BRC_TRAEFIK_PORT: String(proxyPort),
    BRC_TRAEFIK_HEALTH_PORT: String(healthPort),
  };
  const settings = settingsFor(env);
  const services = createDefaultServices(brcPaths, settings, env);
  settings.proxy.concurrent = 100;
  const traefikSpec = services.find((service) => service.name === 'traefik');
  assert.ok(traefikSpec);
  const processManager = new ProcessManager(brcPaths, { startupTimeoutMs: 20_000, shutdownTimeoutMs: 3_000, pollIntervalMs: 50 });
  serviceManager = new ServiceManager(brcPaths, [traefikSpec], processManager, processManager, new LifecycleLock(brcPaths));
  const manager = new TraefikManager(brcPaths, settings, serviceManager);
  await manager.writeConfig();

  await serviceManager.start();
  assert.equal(await httpStatus(healthPort, '/ping'), 200);
  const initialGeneration = await httpHeader(healthPort, '/ping', 'x-brc-config-generation');
  assert.ok(initialGeneration, 'loopback health must report the active dynamic config generation.');
  await manager.writeConfig(settings);
  const appliedGeneration = await httpHeader(healthPort, '/ping', 'x-brc-config-generation');
  assert.notEqual(appliedGeneration, initialGeneration, 'config apply must wait until the running Traefik loads the new generation.');
  const nextRelayPort = (await reservePorts(1))[0];
  const nextSettings = structuredClone(settings);
  nextSettings.services.relayPort = nextRelayPort;
  await serviceManager.withLock(() => manager.writeConfigWithLockHeld(nextSettings, settings));
  assert.equal(
    await httpStatus(proxyPort, '/relay-port-pending'),
    204,
    'a pending Relay port change must not redirect live Traefik traffic before Relay restarts.',
  );
  let dynamic = yaml.load(await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8'));
  assert.equal(dynamic.http.services.backend.loadBalancer.servers[0].url, `http://127.0.0.1:${relayPort}`);
  await serviceManager.withLock(() => manager.writeConfigWithLockHeld(settings, settings));
  assert.equal(await httpStatus(proxyPort, '/relay-port-rollback'), 204);
  dynamic = yaml.load(await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8'));
  assert.equal(dynamic.http.services.backend.loadBalancer.servers[0].url, `http://127.0.0.1:${relayPort}`);
  await serviceManager.withLock(async (operations) => {
    await operations.stop();
    await manager.writeConfigWithLockHeld(nextSettings);
    dynamic = yaml.load(await readFile(path.join(brcPaths.traefik, 'config', 'dynamic.yml'), 'utf8'));
    assert.equal(dynamic.http.services.backend.loadBalancer.servers[0].url, `http://127.0.0.1:${nextRelayPort}`);
    await operations.start();
  });
  await serviceManager.withLock(async (operations) => {
    await operations.stop();
    await manager.writeConfigWithLockHeld(settings);
    await operations.start();
  });
  assert.equal(await httpStatus(proxyPort, '/relay-port-restored'), 204);
  await sleep(3200);
  events.length = 0;
  const burstStartedAt = Date.now();
  const burst = await Promise.all(Array.from({ length: 50 }, (_, index) => httpStatus(proxyPort, ['/oauth/callback', '/mcp', '/health'][index % 3], {
    localAddress: index % 2 === 0 ? '127.0.0.1' : '127.0.0.2',
    headers: {
      Host: `host-${index}.invalid`,
      'X-Forwarded-For': `198.51.100.${index + 1}`,
      'X-BRC-Limit-Key': `spoof-${index}`,
    },
  })));
  const burstDurationMs = Date.now() - burstStartedAt;
  const accepted = burst.filter((code) => code === 204).length;
  const rejected = burst.filter((code) => code === 429).length;
  assert.equal(settings.proxy.rate.period, '1s');
  const maxAccepted = settings.proxy.rate.burst + Math.ceil(settings.proxy.rate.average * burstDurationMs / 1_000);
  assert.ok(accepted >= settings.proxy.rate.burst, `Initial burst was not available: ${accepted}/${burst.length} accepted.`);
  assert.ok(accepted <= maxAccepted, `${accepted} accepted in ${burstDurationMs} ms; expected at most ${maxAccepted}.`);
  assert.equal(rejected, burst.length - accepted);
  assert.ok(rejected > 0, 'The shared rate limit must reject requests in this burst.');
  assert.equal(events.length, accepted);
  assert.ok(events.every((event) => event.key === 'global-v1'));
  const forwardedSources = new Set(events.map((event) => event.xff));
  assert.deepEqual([...forwardedSources].sort(), ['127.0.0.1', '127.0.0.2']);
  assert.ok(events.every((event) => !event.xff?.includes('198.51.100.')), 'Traefik must ignore untrusted client X-Forwarded-For values.');

  await serviceManager.stop();
  settings.proxy.concurrent = 16;
  await manager.writeConfig();
  await serviceManager.start();
  await sleep(3200);
  assert.equal(active, 0, 'Rate-limit requests must finish before measuring concurrent connections.');
  peak = 0;
  const fourSockets = await Promise.all(Array.from({ length: 4 }, () => websocketStatus(proxyPort)));
  assert.ok(fourSockets.every((result) => result.status === 101));
  const mixed = await Promise.all(Array.from({ length: 13 }, () => httpStatus(proxyPort, '/mcp?hold=300')));
  assert.equal(mixed.filter((code) => code === 204).length, 12);
  assert.equal(mixed.filter((code) => code === 429).length, 1);
  assert.equal(peak, 16);
  for (const result of fourSockets) result.socket.end();
  await sleep(100);

  await sleep(3200);
  assert.equal(active, 0, 'Previous HTTP requests and WebSockets must finish before the next burst.');
  assert.equal(webSockets, 0, 'Earlier WebSockets must release their in-flight slots.');
  const seventeenSockets = await Promise.all(Array.from({ length: 17 }, () => websocketStatus(proxyPort)));
  assert.equal(seventeenSockets.filter((result) => result.status === 101).length, 16);
  assert.equal(seventeenSockets.filter((result) => result.status === 429).length, 1);
  for (const result of seventeenSockets) result.socket.end();
  await sleep(100);

  assert.equal(await httpStatus(proxyPort, '/oauth/callback?code=abc&state=xyz'), 204);
  assert.equal(await httpStatus(proxyPort, '/mcp'), 204);
  assert.equal(await websocketStatus(proxyPort, '/ws').then((result) => { result.socket.end(); return result.status; }), 101);
  assert.equal(await httpStatus(proxyPort, '/oauth%2Fcallback'), 400);
  assert.equal(await httpStatus(proxyPort, '/mcp', { headers: { 'X.Auth.User': 'spoofed' } }), 400);
  assert.equal(webSockets, 0);
});

test('Traefik input, processing, and output keep isolated responsibilities', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const downloadBytes = [];
  const input = new TraefikInput({
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        const half = Math.floor(release.archive.length / 2);
        controller.enqueue(release.archive.subarray(0, half));
        controller.enqueue(release.archive.subarray(half));
        controller.close();
      },
    }), { headers: { 'content-length': String(release.archive.length) } }),
  });

  const archiveName = `traefik_v3.7.16${traefikAssetSuffix}`;
  const archive = await input.downloadArchive(
    { version: '3.7.16', archiveName, archiveUrl: `https://example.test/${archiveName}`, checksumUrl: '' },
    (completedBytes, totalBytes) => downloadBytes.push([completedBytes, totalBytes]),
  );
  assert.ok(archive instanceof Uint8Array);
  assert.deepEqual(downloadBytes, [
    [Math.floor(release.archive.length / 2), release.archive.length],
    [release.archive.length, release.archive.length],
  ]);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(brcPaths.root), []);

  const { processArchive } = await import('../packages/cli/dist/adapters/traefik/archive.js');
  const executable = await processArchive(archive, createHash('sha256').update(release.archive).digest('hex'), archiveName, traefikBinary);
  assert.equal(executable.path, traefikBinary);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(brcPaths.root), []);

  const stage = await new TraefikOutput(brcPaths).stageArchive({ version: '3.7.16' }, executable);
  assert.equal(await readFile(path.join(stage, traefikBinary), 'utf8'), 'binary-3.7.16');
});

test('setup emits streamed download bytes and verifies before staging', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const events = [];
  const originalFetch = release.fetch;
  const manager = makeManager(brcPaths, release, {
    reporter: (event) => events.push(event),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith(traefikAssetSuffix)) return originalFetch(input, init);
      const half = Math.floor(release.archive.length / 2);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(release.archive.subarray(0, half));
          controller.enqueue(release.archive.subarray(half));
          controller.close();
        },
      }), { headers: { 'content-length': String(release.archive.length) } });
    },
  });
  await manager.setup();
  const bytes = events.filter((event) => event.stage === 'download' && event.status === 'started' && event.completedBytes > 0);
  assert.deepEqual(bytes.map((event) => event.completedBytes), [Math.floor(release.archive.length / 2), release.archive.length]);
  assert.ok(bytes.every((event) => event.totalBytes === release.archive.length));
  const verify = events.findIndex((event) => event.stage === 'verify' && event.status === 'started' && events.indexOf(event) > events.indexOf(bytes.at(-1)));
  const stage = events.findIndex((event) => event.stage === 'stage' && event.status === 'started');
  assert.ok(verify > 0 && stage > verify);
});

test('download with unknown length never reports a total', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const events = [];
  await makeManager(brcPaths, release, { reporter: (event) => events.push(event) }).setup();
  const download = events.filter((event) => event.stage === 'download');
  assert.ok(download.some((event) => event.status === 'completed'));
  assert.ok(download.every((event) => event.totalBytes === undefined));
});

test('reporter errors cannot replace an operation failure or leak staging', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16', { checksum: '0'.repeat(64) });
  const manager = makeManager(brcPaths, release, { reporter: () => { throw new Error('reporter failed'); } });
  await assert.rejects(manager.setup(), /checksum/i);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(brcPaths.traefik, 'versions')), []);
  assert.deepEqual(await readdir(brcPaths.tmp), []);
});

test('checksum failure emits failed verification without completed verification', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16', { checksum: '0'.repeat(64) });
  const events = [];
  await assert.rejects(makeManager(brcPaths, release, { reporter: (event) => events.push(event) }).setup(), /checksum/i);
  assert.ok(events.some((event) => event.stage === 'download' && event.status === 'completed'));
  assert.ok(events.some((event) => event.stage === 'verify' && event.status === 'failed'));
  assert.ok(!events.some((event) => event.stage === 'verify' && event.status === 'completed'));
});

test('configuration and rollback emit their own phase events', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const events = [];
  const manager = makeManager(brcPaths, release, { reporter: (event) => events.push(event) });
  await manager.setup();
  release.setVersion('3.7.17');
  await manager.update();
  await manager.writeConfig();
  await manager.rollbackUpdate();
  for (const [operation, stage] of [['config', 'config'], ['update', 'activate'], ['rollback', 'verify'], ['rollback', 'health'], ['rollback', 'activate']]) {
    assert.ok(events.some((event) => event.operation === operation && event.stage === stage && event.status === 'completed'));
  }
});

test('asynchronous progress output failure preserves checksum failure and staging cleanup', async (t) => {
  const { Writable } = await import('node:stream');
  const { TraefikProgress } = await import('../packages/cli/dist/adapters/terminal/progress.js');
  const { paths: brcPaths } = await makeRoot(t);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('closed output'), { code: 'EPIPE' }));
    },
  });
  output.isTTY = true;
  const progress = new TraefikProgress(output);
  const release = makeRelease('3.7.16', { checksum: '0'.repeat(64) });
  await assert.rejects(makeManager(brcPaths, release, { reporter: (event) => progress.report(event) }).setup(), /checksum/i);
  await new Promise((resolve) => setImmediate(resolve));
  progress.stop();
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(brcPaths.traefik, 'versions')), []);
  assert.deepEqual(await readdir(brcPaths.tmp), []);
});

test('ArchiveExtractorFactory creates ZipArchiveExtractor and TarGzArchiveExtractor', async () => {
  const { ArchiveExtractorFactory, ZipArchiveExtractor, TarGzArchiveExtractor } = await import('../packages/cli/dist/adapters/traefik/archive.js');
  const zipExtractor = ArchiveExtractorFactory.create('zip');
  assert.ok(zipExtractor instanceof ZipArchiveExtractor);
  const tarExtractor = ArchiveExtractorFactory.create('tar.gz');
  assert.ok(tarExtractor instanceof TarGzArchiveExtractor);
  assert.throws(() => ArchiveExtractorFactory.create('rar'), /Unsupported archive format/);
});

test('ZipArchiveExtractor extracts executable with stream and validates safety', async () => {
  const { ZipArchiveExtractor } = await import('../packages/cli/dist/adapters/traefik/archive.js');
  const extractor = new ZipArchiveExtractor();
  const validZip = makeZip([
    { name: 'traefik.exe', contents: 'binary-zip-content' },
    { name: 'README.md', contents: 'readme' },
  ]);
  const entry = await extractor.extractExecutable(validZip, 'traefik.exe');
  assert.equal(entry.name, 'traefik.exe');
  assert.equal(entry.size, 18);
  const chunks = [];
  for await (const chunk of entry.openStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'binary-zip-content');

  const unsafeZip = makeZip([{ name: '../traefik.exe', contents: 'bad' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeZip, 'traefik.exe'), /unsafe path/);

  const missingZip = makeZip([{ name: 'other.exe', contents: 'other' }]);
  await assert.rejects(() => extractor.extractExecutable(missingZip, 'traefik.exe'), /does not contain a valid root-level/);
});

test('TarGzArchiveExtractor extracts executable with stream and validates safety', async () => {
  const { TarGzArchiveExtractor } = await import('../packages/cli/dist/adapters/traefik/archive.js');
  const extractor = new TarGzArchiveExtractor();
  const validTarGz = makeTarGz([
    { name: 'traefik', contents: 'binary-targz-content' },
    { name: 'LICENSE', contents: 'mit' },
  ]);
  const entry = await extractor.extractExecutable(validTarGz, 'traefik');
  assert.equal(entry.name, 'traefik');
  assert.equal(entry.size, 20);
  const chunks = [];
  for await (const chunk of entry.openStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'binary-targz-content');

  const unsafeTarGz = makeTarGz([{ name: '/etc/traefik', contents: 'bad' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeTarGz, 'traefik'), /unsafe path/);

  const duplicateTarGz = makeTarGz([
    { name: 'traefik', contents: 'first' },
    { name: 'traefik', contents: 'second' },
  ]);
  await assert.rejects(() => extractor.extractExecutable(duplicateTarGz, 'traefik'), /duplicate path/);

  const missingTarGz = makeTarGz([{ name: 'other', contents: 'other' }]);
  await assert.rejects(() => extractor.extractExecutable(missingTarGz, 'traefik'), /does not contain a valid root-level/);
});

test('TraefikOutput stages ArchiveBinaryEntry with openStream and sets file permissions', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const { TraefikOutput } = await import('../packages/cli/dist/adapters/traefik/output.js');
  const { Readable } = await import('node:stream');
  const output = new TraefikOutput(brcPaths);
  const binaryContent = Buffer.from('traefik-staged-binary');
  const entry = {
    name: process.platform === 'win32' ? 'traefik.exe' : 'traefik',
    size: binaryContent.length,
    openStream: () => Readable.from([binaryContent]),
  };
  const stage = await output.stageArchive({ version: '3.7.17' }, entry);
  const stagedPath = path.join(stage, entry.name);
  assert.equal(await readFile(stagedPath, 'utf8'), 'traefik-staged-binary');
  const fileStat = await stat(stagedPath);
  assert.equal(fileStat.size, binaryContent.length);
});

test('Traefik release lookup and archive streaming honor command cancellation', async () => {
  const controller = new AbortController();
  const input = new TraefikInput({
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('request aborted')), { once: true });
    }),
  });
  const lookup = input.latestRelease(controller.signal);
  controller.abort(new Error('Traefik lookup cancelled'));
  await assert.rejects(lookup, /Traefik lookup cancelled/);

  const downloadController = new AbortController();
  const downloadInput = new TraefikInput({
    fetch: async (_url, init) => new Response(new ReadableStream({
      start() {
        init.signal.addEventListener('abort', () => {}, { once: true });
      },
    })),
  });
  const download = downloadInput.downloadArchive({
    version: '3.7.16',
    archiveName: 'traefik_v3.7.16_windows_amd64.zip',
    archiveUrl: 'https://example.test/archive.zip',
    checksumUrl: '',
  }, undefined, downloadController.signal);
  await sleep(10);
  downloadController.abort(new Error('Traefik download cancelled'));
  await assert.rejects(download, /Traefik download cancelled/);
});
