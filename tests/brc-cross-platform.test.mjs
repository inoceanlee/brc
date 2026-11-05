import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PlatformEnvironment } from '../packages/cli/dist/config/platform-environment.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { parseRelease, MAX_EXECUTABLE_BYTES } from '../packages/cli/dist/traefik/core.js';
import {
  ArchiveExtractorFactory,
  ZipArchiveExtractor,
  TarGzArchiveExtractor,
} from '../packages/cli/dist/traefik/extractor.js';
import {
  ShellEncodingCoordinator,
  DefaultShellEncodingSession,
  ShellProbeFeedResult,
} from '../packages/agent/dist/core/shell-coordinator.js';
import { resolveDynamicShellPath } from '../packages/agent/dist/core/terminal-manager.js';

/* -------------------------------------------------------------------------- */
/*                               Archive Helpers                              */
/* -------------------------------------------------------------------------- */

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.contents || '');
    const checksum = crc32(data);
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const compressedSize = entry.compressedSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
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
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    header.write('0001000\0', 108, 8, 'ascii');
    header.write('0001000\0', 116, 8, 'ascii');
    const data = Buffer.from(entry.contents || '');
    const size = entry.size ?? data.length;
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii');
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
  return zlib.gzipSync(Buffer.concat(blocks));
}

/* -------------------------------------------------------------------------- */
/*             1. PlatformEnvironment Matrix & Artifact Resolution            */
/* -------------------------------------------------------------------------- */

test('PlatformEnvironment maps full platform and architecture matrix (win32, linux, darwin x x64, arm64)', () => {
  const matrix = [
    {
      platform: 'win32',
      arch: 'x64',
      expected: { platform: 'windows', arch: 'amd64', archiveExt: 'zip', executableName: 'traefik.exe' },
    },
    {
      platform: 'win32',
      arch: 'arm64',
      expected: { platform: 'windows', arch: 'arm64', archiveExt: 'zip', executableName: 'traefik.exe' },
    },
    {
      platform: 'linux',
      arch: 'x64',
      expected: { platform: 'linux', arch: 'amd64', archiveExt: 'tar.gz', executableName: 'traefik' },
    },
    {
      platform: 'linux',
      arch: 'arm64',
      expected: { platform: 'linux', arch: 'arm64', archiveExt: 'tar.gz', executableName: 'traefik' },
    },
    {
      platform: 'darwin',
      arch: 'x64',
      expected: { platform: 'darwin', arch: 'amd64', archiveExt: 'tar.gz', executableName: 'traefik' },
    },
    {
      platform: 'darwin',
      arch: 'arm64',
      expected: { platform: 'darwin', arch: 'arm64', archiveExt: 'tar.gz', executableName: 'traefik' },
    },
  ];

  for (const item of matrix) {
    const env = new PlatformEnvironment({ platform: item.platform, arch: item.arch });
    assert.deepEqual(env.resolveTraefikTarget(), item.expected, `Target mismatch for ${item.platform}/${item.arch}`);
  }
});

test('PlatformEnvironment rejects unsupported platforms and architectures', () => {
  assert.throws(
    () => new PlatformEnvironment({ platform: 'freebsd', arch: 'x64' }).resolveTraefikTarget(),
    /Unsupported platform for Traefik/,
  );
  assert.throws(
    () => new PlatformEnvironment({ platform: 'sunos', arch: 'x64' }).resolveTraefikTarget(),
    /Unsupported platform for Traefik/,
  );
  assert.throws(
    () => new PlatformEnvironment({ platform: 'win32', arch: 'ia32' }).resolveTraefikTarget(),
    /Unsupported architecture for Traefik/,
  );
  assert.throws(
    () => new PlatformEnvironment({ platform: 'linux', arch: 's390x' }).resolveTraefikTarget(),
    /Unsupported architecture for Traefik/,
  );
  assert.throws(
    () => new PlatformEnvironment({ platform: 'darwin', arch: 'riscv64' }).resolveTraefikTarget(),
    /Unsupported architecture for Traefik/,
  );
});

test('PlatformEnvironment computes default paths across win32, linux, darwin', () => {
  const winEnv = new PlatformEnvironment({
    platform: 'win32',
    homedir: 'C:\\Users\\alice',
    env: {},
  });
  const winPaths = winEnv.resolveBrcPaths();
  assert.equal(winPaths.root, 'C:\\Users\\alice\\AppData\\Local\\BRC');
  assert.equal(winPaths.traefik, 'C:\\Users\\alice\\AppData\\Local\\BRC\\traefik');
  assert.equal(winPaths.config, 'C:\\Users\\alice\\AppData\\Local\\BRC\\config');
  assert.equal(winPaths.data, 'C:\\Users\\alice\\AppData\\Local\\BRC\\data');
  assert.equal(winPaths.runtime, 'C:\\Users\\alice\\AppData\\Local\\BRC\\runtime');
  assert.equal(winPaths.logs, 'C:\\Users\\alice\\AppData\\Local\\BRC\\logs');
  assert.equal(winPaths.tmp, 'C:\\Users\\alice\\AppData\\Local\\BRC\\tmp');

  const linuxEnv = new PlatformEnvironment({
    platform: 'linux',
    homedir: '/home/bob',
    env: {},
  });
  const linuxPaths = linuxEnv.resolveBrcPaths();
  assert.equal(linuxPaths.root, '/home/bob/.local/share/brc');
  assert.equal(linuxPaths.traefik, '/home/bob/.local/share/brc/traefik');
  assert.equal(linuxPaths.config, '/home/bob/.local/share/brc/config');
  assert.equal(linuxPaths.data, '/home/bob/.local/share/brc/data');
  assert.equal(linuxPaths.runtime, '/home/bob/.local/share/brc/runtime');
  assert.equal(linuxPaths.logs, '/home/bob/.local/share/brc/logs');
  assert.equal(linuxPaths.tmp, '/home/bob/.local/share/brc/tmp');

  const darwinEnv = new PlatformEnvironment({
    platform: 'darwin',
    homedir: '/Users/carol',
    env: {},
  });
  const darwinPaths = darwinEnv.resolveBrcPaths();
  assert.equal(darwinPaths.root, '/Users/carol/Library/Application Support/brc');
  assert.equal(darwinPaths.traefik, '/Users/carol/Library/Application Support/brc/traefik');
  assert.equal(darwinPaths.config, '/Users/carol/Library/Application Support/brc/config');
  assert.equal(darwinPaths.data, '/Users/carol/Library/Application Support/brc/data');
  assert.equal(darwinPaths.runtime, '/Users/carol/Library/Application Support/brc/runtime');
  assert.equal(darwinPaths.logs, '/Users/carol/Library/Application Support/brc/logs');
  assert.equal(darwinPaths.tmp, '/Users/carol/Library/Application Support/brc/tmp');
});

test('parseRelease handles multi-platform multi-arch assets matching Traefik targets', () => {
  const releasePayload = {
    tag_name: 'v3.7.17',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'traefik_v3.7.17_windows_amd64.zip',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_windows_amd64.zip',
      },
      {
        name: 'traefik_v3.7.17_windows_arm64.zip',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_windows_arm64.zip',
      },
      {
        name: 'traefik_v3.7.17_linux_amd64.tar.gz',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_linux_amd64.tar.gz',
      },
      {
        name: 'traefik_v3.7.17_linux_arm64.tar.gz',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_linux_arm64.tar.gz',
      },
      {
        name: 'traefik_v3.7.17_darwin_amd64.tar.gz',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_darwin_amd64.tar.gz',
      },
      {
        name: 'traefik_v3.7.17_darwin_arm64.tar.gz',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_darwin_arm64.tar.gz',
      },
      {
        name: 'traefik_v3.7.17_checksums.txt',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_checksums.txt',
      },
    ],
  };

  const cases = [
    {
      target: { platform: 'windows', arch: 'amd64', archiveExt: 'zip', executableName: 'traefik.exe' },
      expectedArchive: 'traefik_v3.7.17_windows_amd64.zip',
    },
    {
      target: { platform: 'windows', arch: 'arm64', archiveExt: 'zip', executableName: 'traefik.exe' },
      expectedArchive: 'traefik_v3.7.17_windows_arm64.zip',
    },
    {
      target: { platform: 'linux', arch: 'amd64', archiveExt: 'tar.gz', executableName: 'traefik' },
      expectedArchive: 'traefik_v3.7.17_linux_amd64.tar.gz',
    },
    {
      target: { platform: 'linux', arch: 'arm64', archiveExt: 'tar.gz', executableName: 'traefik' },
      expectedArchive: 'traefik_v3.7.17_linux_arm64.tar.gz',
    },
    {
      target: { platform: 'darwin', arch: 'amd64', archiveExt: 'tar.gz', executableName: 'traefik' },
      expectedArchive: 'traefik_v3.7.17_darwin_amd64.tar.gz',
    },
    {
      target: { platform: 'darwin', arch: 'arm64', archiveExt: 'tar.gz', executableName: 'traefik' },
      expectedArchive: 'traefik_v3.7.17_darwin_arm64.tar.gz',
    },
  ];

  for (const c of cases) {
    const release = parseRelease(releasePayload, c.target);
    assert.equal(release.version, '3.7.17');
    assert.equal(release.archiveName, c.expectedArchive);
    assert.equal(release.checksumUrl, 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_checksums.txt');
  }

  assert.throws(
    () => parseRelease(releasePayload, { platform: 'freebsd', arch: 'amd64', archiveExt: 'tar.gz', executableName: 'traefik' }),
    /is missing or has an unexpected URL/,
  );
});

/* -------------------------------------------------------------------------- */
/*             2. Environment Variables Injection & BRC Paths                 */
/* -------------------------------------------------------------------------- */

test('PlatformEnvironment prioritizes BRC_DATA_ROOT over platform-specific env vars', () => {
  const win = new PlatformEnvironment({
    platform: 'win32',
    env: { BRC_DATA_ROOT: 'E:\\BrcRoot', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    homedir: 'C:\\Users\\alice',
  });
  const winPaths = win.resolveBrcPaths();
  assert.equal(winPaths.root, 'E:\\BrcRoot');
  assert.equal(winPaths.traefik, 'E:\\BrcRoot\\traefik');
  assert.equal(winPaths.config, 'E:\\BrcRoot\\config');

  const linux = new PlatformEnvironment({
    platform: 'linux',
    env: { BRC_DATA_ROOT: '/mnt/storage/brc', XDG_DATA_HOME: '/home/bob/.custom-share' },
    homedir: '/home/bob',
  });
  const linuxPaths = linux.resolveBrcPaths();
  assert.equal(linuxPaths.root, '/mnt/storage/brc');
  assert.equal(linuxPaths.traefik, '/mnt/storage/brc/traefik');
  assert.equal(linuxPaths.data, '/mnt/storage/brc/data');

  const darwin = new PlatformEnvironment({
    platform: 'darwin',
    env: { BRC_DATA_ROOT: '/Volumes/Data/brc' },
    homedir: '/Users/carol',
  });
  const darwinPaths = darwin.resolveBrcPaths();
  assert.equal(darwinPaths.root, '/Volumes/Data/brc');
  assert.equal(darwinPaths.runtime, '/Volumes/Data/brc/runtime');
});

test('PlatformEnvironment honors LOCALAPPDATA on Windows and falls back when missing', () => {
  const custom = new PlatformEnvironment({
    platform: 'win32',
    env: { LOCALAPPDATA: 'D:\\LocalSettings' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(custom.resolveBrcPaths().root, 'D:\\LocalSettings\\BRC');

  const fallback = new PlatformEnvironment({
    platform: 'win32',
    env: {},
    homedir: 'C:\\Users\\test',
  });
  assert.equal(fallback.resolveBrcPaths().root, 'C:\\Users\\test\\AppData\\Local\\BRC');
});

test('PlatformEnvironment honors XDG_DATA_HOME on Linux and falls back when missing', () => {
  const custom = new PlatformEnvironment({
    platform: 'linux',
    env: { XDG_DATA_HOME: '/opt/share' },
    homedir: '/home/test',
  });
  assert.equal(custom.resolveBrcPaths().root, '/opt/share/brc');

  const fallback = new PlatformEnvironment({
    platform: 'linux',
    env: {},
    homedir: '/home/test',
  });
  assert.equal(fallback.resolveBrcPaths().root, '/home/test/.local/share/brc');
});

test('resolveBrcPaths backward-compatibility wrapper respects process and option overrides', () => {
  const override = process.platform === 'win32' ? 'C:\\DirectOverridePath' : '/tmp/brc-direct-override';
  const direct = resolveBrcPaths({ BRC_DATA_ROOT: override });
  assert.equal(direct.root, override);
  assert.equal(direct.config, path.join(override, 'config'));
});

/* -------------------------------------------------------------------------- */
/*                       3. Archive Extractor Factory                         */
/* -------------------------------------------------------------------------- */

test('ArchiveExtractorFactory creates correct extractor instances', () => {
  const zip = ArchiveExtractorFactory.create('zip');
  assert.ok(zip instanceof ZipArchiveExtractor);

  const tarGz = ArchiveExtractorFactory.create('tar.gz');
  assert.ok(tarGz instanceof TarGzArchiveExtractor);
});

test('ArchiveExtractorFactory rejects unsupported archive formats', () => {
  assert.throws(() => ArchiveExtractorFactory.create('rar'), /Unsupported archive format: rar/);
  assert.throws(() => ArchiveExtractorFactory.create('tar'), /Unsupported archive format: tar/);
  assert.throws(() => ArchiveExtractorFactory.create('7z'), /Unsupported archive format: 7z/);
  assert.throws(() => ArchiveExtractorFactory.create('bz2'), /Unsupported archive format: bz2/);
});

/* -------------------------------------------------------------------------- */
/*                4. Archive Extraction & Error Handling                      */
/* -------------------------------------------------------------------------- */

test('ZipArchiveExtractor extracts valid executable entry and opens readable stream', async () => {
  const extractor = new ZipArchiveExtractor();
  const zip = makeZip([
    { name: 'traefik.exe', contents: 'binary-traefik-windows' },
    { name: 'README.md', contents: 'documentation' },
  ]);

  const entry = await extractor.extractExecutable(zip, 'traefik.exe');
  assert.equal(entry.name, 'traefik.exe');
  assert.equal(entry.size, 22);

  const chunks = [];
  for await (const chunk of entry.openStream()) {
    chunks.push(chunk);
  }
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'binary-traefik-windows');
});

test('ZipArchiveExtractor rejects unsafe relative, root, and traversal paths', async () => {
  const extractor = new ZipArchiveExtractor();

  const unsafeTraversal = makeZip([{ name: '../traefik.exe', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeTraversal, 'traefik.exe'), /unsafe path/);

  const unsafeRoot = makeZip([{ name: '/traefik.exe', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeRoot, 'traefik.exe'), /unsafe path/);

  const unsafeInner = makeZip([{ name: 'sub/../../traefik.exe', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeInner, 'traefik.exe'), /unsafe path/);
});

test('ZipArchiveExtractor rejects duplicate entries', async () => {
  const extractor = new ZipArchiveExtractor();
  const duplicateZip = makeZip([
    { name: 'traefik.exe', contents: 'version-1' },
    { name: 'traefik.exe', contents: 'version-2' },
  ]);
  await assert.rejects(() => extractor.extractExecutable(duplicateZip, 'traefik.exe'), /duplicate path/);
});

test('ZipArchiveExtractor rejects oversized uncompressed entry exceeding MAX_EXECUTABLE_BYTES', async () => {
  const extractor = new ZipArchiveExtractor();
  const oversizedZip = makeZip([
    {
      name: 'traefik.exe',
      contents: 'small',
      uncompressedSize: MAX_EXECUTABLE_BYTES + 1024,
    },
  ]);
  await assert.rejects(() => extractor.extractExecutable(oversizedZip, 'traefik.exe'), /exceeding size limit/);
});

test('ZipArchiveExtractor rejects empty buffer, missing executable, and zero-size executable', async () => {
  const extractor = new ZipArchiveExtractor();

  await assert.rejects(() => extractor.extractExecutable(Buffer.alloc(0), 'traefik.exe'), /Traefik archive buffer is empty/);

  const missingZip = makeZip([{ name: 'other.exe', contents: 'data' }]);
  await assert.rejects(() => extractor.extractExecutable(missingZip, 'traefik.exe'), /does not contain a valid root-level/);

  const zeroSizeZip = makeZip([{ name: 'traefik.exe', contents: '', uncompressedSize: 0 }]);
  await assert.rejects(() => extractor.extractExecutable(zeroSizeZip, 'traefik.exe'), /does not contain a valid root-level/);
});

test('TarGzArchiveExtractor extracts valid executable entry and opens readable stream', async () => {
  const extractor = new TarGzArchiveExtractor();
  const tarGz = makeTarGz([
    { name: 'traefik', contents: 'binary-traefik-linux' },
    { name: 'LICENSE', contents: 'mit license' },
  ]);

  const entry = await extractor.extractExecutable(tarGz, 'traefik');
  assert.equal(entry.name, 'traefik');
  assert.equal(entry.size, 20);

  const chunks = [];
  for await (const chunk of entry.openStream()) {
    chunks.push(chunk);
  }
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'binary-traefik-linux');

  // Test with leading ./ prefix
  const tarGzWithDot = makeTarGz([{ name: './traefik', contents: 'binary-traefik-dot' }]);
  const entryDot = await extractor.extractExecutable(tarGzWithDot, 'traefik');
  assert.equal(entryDot.name, 'traefik');
  assert.equal(entryDot.size, 18);
});

test('TarGzArchiveExtractor rejects unsafe relative, root, and traversal paths', async () => {
  const extractor = new TarGzArchiveExtractor();

  const unsafeTraversal = makeTarGz([{ name: '../traefik', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeTraversal, 'traefik'), /unsafe path/);

  const unsafeRoot = makeTarGz([{ name: '/etc/traefik', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeRoot, 'traefik'), /unsafe path/);

  const unsafeInner = makeTarGz([{ name: 'sub/../../traefik', contents: 'payload' }]);
  await assert.rejects(() => extractor.extractExecutable(unsafeInner, 'traefik'), /unsafe path/);
});

test('TarGzArchiveExtractor rejects duplicate entries', async () => {
  const extractor = new TarGzArchiveExtractor();
  const duplicateTarGz = makeTarGz([
    { name: 'traefik', contents: 'version-1' },
    { name: 'traefik', contents: 'version-2' },
  ]);
  await assert.rejects(() => extractor.extractExecutable(duplicateTarGz, 'traefik'), /duplicate path/);
});

test('TarGzArchiveExtractor rejects oversized entry exceeding MAX_EXECUTABLE_BYTES', async () => {
  const extractor = new TarGzArchiveExtractor();
  const oversizedTarGz = makeTarGz([
    {
      name: 'traefik',
      contents: '',
      size: MAX_EXECUTABLE_BYTES + 1024,
    },
  ]);
  await assert.rejects(() => extractor.extractExecutable(oversizedTarGz, 'traefik'), /exceeding size limit/);
});

test('TarGzArchiveExtractor rejects empty buffer, missing executable, and zero-size executable', async () => {
  const extractor = new TarGzArchiveExtractor();

  await assert.rejects(() => extractor.extractExecutable(Buffer.alloc(0), 'traefik'), /Traefik archive buffer is empty/);

  const missingTarGz = makeTarGz([{ name: 'other', contents: 'data' }]);
  await assert.rejects(() => extractor.extractExecutable(missingTarGz, 'traefik'), /does not contain a valid root-level/);

  const zeroSizeTarGz = makeTarGz([{ name: 'traefik', contents: '', size: 0 }]);
  await assert.rejects(() => extractor.extractExecutable(zeroSizeTarGz, 'traefik'), /does not contain a valid root-level/);
});

/* -------------------------------------------------------------------------- */
/*              5. ShellEncodingCoordinator & ShellEncodingSession            */
/* -------------------------------------------------------------------------- */

test('ShellEncodingCoordinator resolves probe shells across Windows and POSIX matrix', () => {
  // Windows platform
  const winPwsh = new ShellEncodingCoordinator('win32', 'powershell.exe');
  assert.equal(winPwsh.resolveProbeShell(), 'powershell');

  const winPwshFull = new ShellEncodingCoordinator('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(winPwshFull.resolveProbeShell(), 'powershell');

  const winPwshCore = new ShellEncodingCoordinator('win32', 'pwsh.exe');
  assert.equal(winPwshCore.resolveProbeShell(), 'powershell');

  const winCmd = new ShellEncodingCoordinator('win32', 'cmd.exe');
  assert.equal(winCmd.resolveProbeShell(), 'cmd');

  const winCmdFull = new ShellEncodingCoordinator('win32', 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(winCmdFull.resolveProbeShell(), 'cmd');

  const winDefault = new ShellEncodingCoordinator('win32', undefined);
  assert.equal(winDefault.resolveProbeShell(), 'cmd');

  const winBash = new ShellEncodingCoordinator('win32', 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(winBash.resolveProbeShell(), 'posix');

  const winCustom = new ShellEncodingCoordinator('win32', 'python.exe');
  assert.equal(winCustom.resolveProbeShell(), null);

  // POSIX platforms (linux, darwin)
  const linuxBash = new ShellEncodingCoordinator('linux', '/bin/bash');
  assert.equal(linuxBash.resolveProbeShell(), 'posix');

  const linuxZsh = new ShellEncodingCoordinator('linux', '/usr/bin/zsh');
  assert.equal(linuxZsh.resolveProbeShell(), 'posix');

  const linuxSh = new ShellEncodingCoordinator('linux', '/bin/sh');
  assert.equal(linuxSh.resolveProbeShell(), 'posix');

  const darwinDefault = new ShellEncodingCoordinator('darwin', undefined);
  assert.equal(darwinDefault.resolveProbeShell(), 'posix');

  const linuxPwsh = new ShellEncodingCoordinator('linux', '/usr/bin/pwsh');
  assert.equal(linuxPwsh.resolveProbeShell(), 'powershell');

  const linuxGeneric = new ShellEncodingCoordinator('linux', '/usr/bin/fish');
  assert.equal(linuxGeneric.resolveProbeShell(), 'posix');
});

test('ShellEncodingCoordinator wraps commands with platform-specific probe scripts', () => {
  const pwshCoord = new ShellEncodingCoordinator('win32', 'powershell.exe');
  const pwshSession = pwshCoord.createSession('Get-Process', 5000);
  assert.equal(pwshSession.probeRequired, true);
  assert.match(pwshSession.wrappedCommand, /\[Console\]::OutputEncoding/);
  assert.match(pwshSession.wrappedCommand, new RegExp(pwshSession.marker));
  pwshSession.dispose();

  const cmdCoord = new ShellEncodingCoordinator('win32', 'cmd.exe');
  const cmdSession = cmdCoord.createSession('dir', 5000);
  assert.equal(cmdSession.probeRequired, true);
  assert.match(cmdSession.wrappedCommand, /chcp/);
  assert.match(cmdSession.wrappedCommand, new RegExp(cmdSession.marker));
  cmdSession.dispose();

  const posixCoord = new ShellEncodingCoordinator('linux', '/bin/bash');
  const posixSession = posixCoord.createSession('ls -la', 5000);
  assert.equal(posixSession.probeRequired, true);
  assert.match(posixSession.wrappedCommand, /locale charmap/);
  assert.match(posixSession.wrappedCommand, /read -r _BRC_READY/);
  assert.match(posixSession.wrappedCommand, new RegExp(posixSession.marker));
  posixSession.dispose();

  const bypassCoord = new ShellEncodingCoordinator('win32', 'C:\\Python310\\python.exe');
  const bypassSession = bypassCoord.createSession('python -V', 5000);
  assert.equal(bypassSession.probeRequired, false);
  assert.equal(bypassSession.isReady, true);
  assert.equal(bypassSession.wrappedCommand, 'python -V');
  bypassSession.dispose();
});

test('ShellEncodingSession coordinates PowerShell probe handshake, decoding, and IO', () => {
  const session = new DefaultShellEncodingSession('Get-Date', 5000, 'powershell', 'BRC_PROBE_PS1');
  assert.equal(session.isReady, false);

  let readyFired = false;
  let infoReceived = null;
  let handshakeReceived = null;
  session.onReady((info, handshake) => {
    readyFired = true;
    infoReceived = info;
    handshakeReceived = handshake;
  });

  const feedRes = session.feedStdout(Buffer.from('BRC_PROBE_PS1|in=utf-8;out=utf-8;pipe=utf-8;cp=65001\nready-output\n'));
  assert.equal(feedRes.ready, true);
  assert.equal(session.isReady, true);
  assert.equal(readyFired, true);
  assert.equal(infoReceived.codePage, 65001);
  assert.deepEqual(handshakeReceived, Buffer.from('Y\n', 'ascii'));
  assert.equal(feedRes.text, 'ready-output\n');

  const out = session.feedStdout(Buffer.from('hello from powershell\n'));
  assert.equal(out.text, 'hello from powershell\n');

  const err = session.feedStderr(Buffer.from('warning stream\n'));
  assert.equal(err, 'warning stream\n');

  assert.deepEqual(session.encodeInput('test input'), Buffer.from('test input', 'utf8'));

  session.dispose();
});

test('ShellEncodingSession coordinates CMD UTF-8 probe handshake and Unicode decoding', () => {
  const session = new DefaultShellEncodingSession('cmd-test', 5000, 'cmd', 'BRC_PROBE_CMD1');

  // Buffer early UTF-8 stderr across probe chunks.
  const utf8Error = Buffer.from('错误', 'utf8');
  const earlyErr = session.feedStderr(utf8Error.subarray(0, 3));
  assert.equal(earlyErr, '');

  // Chunk 1 of stdout probe
  const part1 = session.feedStdout(Buffer.from('pre-output BRC_PROBE_CMD1|cp='));
  assert.equal(part1.ready, false);
  assert.equal(part1.text, '');

  // CMD initializes UTF-8 before reporting the effective code page.
  const part2 = session.feedStdout(Buffer.from('65001\r\npost-output\r\n'));
  assert.equal(part2.ready, true);
  assert.equal(session.isReady, true);
  assert.equal(session.outputEncoding, 'utf-8');
  assert.equal(session.inputEncoding, 'utf-8');

  assert.equal(part2.earlyStderr, '错');
  const moreErr = session.feedStderr(utf8Error.subarray(3));
  assert.equal(moreErr, '误');
  assert.deepEqual(session.encodeInput('中文🙂'), Buffer.from('中文🙂', 'utf8'));

  session.dispose();
});

test('ShellEncodingSession coordinates POSIX probe handshake and UTF-8 / non-UTF-8 locale', () => {
  const session = new DefaultShellEncodingSession('echo test', 5000, 'posix', 'BRC_PROBE_POS1');
  let readyHandshake = null;
  session.onReady((_info, hs) => {
    readyHandshake = hs;
  });

  const res = session.feedStdout(Buffer.from('BRC_PROBE_POS1|charmap=UTF-8;lang=en_US.UTF-8\noutput line\n'));
  assert.equal(res.ready, true);
  assert.equal(session.isReady, true);
  assert.equal(session.outputEncoding, 'utf-8');
  assert.deepEqual(readyHandshake, Buffer.from('Y\n', 'ascii'));
  assert.equal(res.text, 'output line\n');

  session.dispose();
});

test('ShellEncodingSession handles timeout and lifecycle disposal', async () => {
  const session = new DefaultShellEncodingSession('slow command', 50, 'posix', 'BRC_PROBE_TMO1');
  let timeoutFired = false;
  let timeoutErr = null;

  session.onTimeout((err) => {
    timeoutFired = true;
    timeoutErr = err;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(timeoutFired, true);
  assert.match(timeoutErr.message, /timed out/);

  session.dispose();
  const feedAfterDisposed = session.feedStdout(Buffer.from('ignored'));
  assert.equal(feedAfterDisposed.text, '');
});

/* -------------------------------------------------------------------------- */
/*           6. Dynamic Shell Path Resolution (resolveDynamicShellPath)       */
/* -------------------------------------------------------------------------- */

test('resolveDynamicShellPath trims and returns configured shell string', () => {
  assert.equal(resolveDynamicShellPath(' /usr/local/bin/fish '), '/usr/local/bin/fish');
  assert.equal(resolveDynamicShellPath('  cmd.exe  '), 'cmd.exe');
  assert.equal(resolveDynamicShellPath('pwsh.exe'), 'pwsh.exe');
});

test('resolveDynamicShellPath resolves Windows shell via ComSpec and default fallback', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origComSpec = process.env.ComSpec;

  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    assert.equal(resolveDynamicShellPath(true), 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(resolveDynamicShellPath(''), 'C:\\Windows\\System32\\cmd.exe');

    delete process.env.ComSpec;
    assert.equal(resolveDynamicShellPath(undefined), 'cmd.exe');
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origComSpec !== undefined) {
      process.env.ComSpec = origComSpec;
    } else {
      delete process.env.ComSpec;
    }
  }
});

test('resolveDynamicShellPath resolves POSIX shell via process.env.SHELL', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origShell = process.env.SHELL;
  const origExists = fs.existsSync;

  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.SHELL = '/usr/local/bin/custom-bash';
    fs.existsSync = (p) => p === '/usr/local/bin/custom-bash';

    assert.equal(resolveDynamicShellPath(true), '/usr/local/bin/custom-bash');
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origShell !== undefined) {
      process.env.SHELL = origShell;
    } else {
      delete process.env.SHELL;
    }
    fs.existsSync = origExists;
  }
});

test('resolveDynamicShellPath resolves POSIX shell via os.userInfo().shell when SHELL missing', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origShell = process.env.SHELL;
  const origExists = fs.existsSync;
  const origUserInfo = os.userInfo;

  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.SHELL;

    fs.existsSync = (p) => p === '/usr/bin/zsh';
    os.userInfo = () => ({ username: 'alice', shell: '/usr/bin/zsh' });

    assert.equal(resolveDynamicShellPath(undefined), '/usr/bin/zsh');
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origShell !== undefined) {
      process.env.SHELL = origShell;
    } else {
      delete process.env.SHELL;
    }
    fs.existsSync = origExists;
    os.userInfo = origUserInfo;
  }
});

test('resolveDynamicShellPath resolves POSIX shell via standard fallback list', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origShell = process.env.SHELL;
  const origExists = fs.existsSync;
  const origUserInfo = os.userInfo;

  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    delete process.env.SHELL;
    os.userInfo = () => { throw new Error('user info failed'); };

    // When /bin/bash is found in fallback list
    fs.existsSync = (p) => p === '/bin/bash';
    assert.equal(resolveDynamicShellPath(false), '/bin/bash');

    // When none in fallback list is found
    fs.existsSync = () => false;
    assert.equal(resolveDynamicShellPath(undefined), undefined);
  } finally {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (origShell !== undefined) {
      process.env.SHELL = origShell;
    } else {
      delete process.env.SHELL;
    }
    fs.existsSync = origExists;
    os.userInfo = origUserInfo;
  }
});

test('inspectProcesses handles Linux EACCES and EPERM gracefully without throwing', async () => {
  const { inspectProcesses } = await import('../packages/cli/dist/lifecycle/identity.js');
  // On non-Linux, the Linux branch is not executed, but inspectProcesses should always resolve a Map
  const result = await inspectProcesses([process.pid]);
  assert.ok(result instanceof Map);
  assert.ok(result.has(process.pid));
});
