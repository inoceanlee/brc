import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { PlatformEnvironment } from '../packages/cli/dist/config/platform-environment.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { parseRelease } from '../packages/cli/dist/adapters/traefik/release.js';

test('PlatformEnvironment resolves Windows paths with LOCALAPPDATA and default homedir', () => {
  const customLocal = new PlatformEnvironment({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\CustomLocal' },
    homedir: 'C:\\Users\\test',
  });
  const paths1 = customLocal.resolveBrcPaths();
  assert.equal(paths1.root, 'C:\\CustomLocal\\BRC');
  assert.equal(paths1.traefik, 'C:\\CustomLocal\\BRC\\traefik');
  assert.equal(paths1.config, 'C:\\CustomLocal\\BRC\\config');
  assert.equal(paths1.data, 'C:\\CustomLocal\\BRC\\data');
  assert.equal(paths1.runtime, 'C:\\CustomLocal\\BRC\\runtime');
  assert.equal(paths1.logs, 'C:\\CustomLocal\\BRC\\logs');
  assert.equal(paths1.tmp, 'C:\\CustomLocal\\BRC\\tmp');

  const defaultLocal = new PlatformEnvironment({
    platform: 'win32',
    env: {},
    homedir: 'C:\\Users\\test',
  });
  const paths2 = defaultLocal.resolveBrcPaths();
  assert.equal(paths2.root, 'C:\\Users\\test\\AppData\\Local\\BRC');
});

test('PlatformEnvironment resolves macOS paths under Application Support', () => {
  const env = new PlatformEnvironment({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
  });
  const paths = env.resolveBrcPaths();
  assert.equal(paths.root, '/Users/test/Library/Application Support/brc');
  assert.equal(paths.traefik, '/Users/test/Library/Application Support/brc/traefik');
  assert.equal(paths.config, '/Users/test/Library/Application Support/brc/config');
  assert.equal(paths.data, '/Users/test/Library/Application Support/brc/data');
  assert.equal(paths.runtime, '/Users/test/Library/Application Support/brc/runtime');
  assert.equal(paths.logs, '/Users/test/Library/Application Support/brc/logs');
  assert.equal(paths.tmp, '/Users/test/Library/Application Support/brc/tmp');
});

test('PlatformEnvironment resolves Linux paths with XDG_DATA_HOME and default homedir', () => {
  const customXdg = new PlatformEnvironment({
    platform: 'linux',
    env: { XDG_DATA_HOME: '/custom/data' },
    homedir: '/home/test',
  });
  const paths1 = customXdg.resolveBrcPaths();
  assert.equal(paths1.root, '/custom/data/brc');
  assert.equal(paths1.traefik, '/custom/data/brc/traefik');

  const defaultXdg = new PlatformEnvironment({
    platform: 'linux',
    env: {},
    homedir: '/home/test',
  });
  const paths2 = defaultXdg.resolveBrcPaths();
  assert.equal(paths2.root, '/home/test/.local/share/brc');
  assert.equal(paths2.config, '/home/test/.local/share/brc/config');
});

test('PlatformEnvironment prioritizes BRC_DATA_ROOT across all platforms', () => {
  const win = new PlatformEnvironment({
    platform: 'win32',
    env: { BRC_DATA_ROOT: 'D:\\brc-custom', LOCALAPPDATA: 'C:\\AppData\\Local' },
    homedir: 'C:\\Users\\test',
  });
  assert.equal(win.resolveBrcPaths().root, 'D:\\brc-custom');

  const linux = new PlatformEnvironment({
    platform: 'linux',
    env: { BRC_DATA_ROOT: '/var/lib/brc', XDG_DATA_HOME: '/home/test/.local/share' },
    homedir: '/home/test',
  });
  assert.equal(linux.resolveBrcPaths().root, '/var/lib/brc');
});

test('resolveBrcPaths maintains backwards compatibility with process env', () => {
  const override = process.platform === 'win32' ? 'C:\\DirectOverride' : '/tmp/brc-direct-override';
  const paths = resolveBrcPaths({ BRC_DATA_ROOT: override });
  assert.equal(paths.root, override);
  assert.equal(paths.config, path.join(override, 'config'));
});

test('PlatformEnvironment maps platforms and architectures to Traefik targets', () => {
  const winAmd64 = new PlatformEnvironment({ platform: 'win32', arch: 'x64' }).resolveTraefikTarget();
  assert.deepEqual(winAmd64, {
    platform: 'windows',
    arch: 'amd64',
    archiveExt: 'zip',
    executableName: 'traefik.exe',
  });

  const winArm64 = new PlatformEnvironment({ platform: 'win32', arch: 'arm64' }).resolveTraefikTarget();
  assert.deepEqual(winArm64, {
    platform: 'windows',
    arch: 'arm64',
    archiveExt: 'zip',
    executableName: 'traefik.exe',
  });

  const linuxAmd64 = new PlatformEnvironment({ platform: 'linux', arch: 'x64' }).resolveTraefikTarget();
  assert.deepEqual(linuxAmd64, {
    platform: 'linux',
    arch: 'amd64',
    archiveExt: 'tar.gz',
    executableName: 'traefik',
  });

  const linuxArm64 = new PlatformEnvironment({ platform: 'linux', arch: 'arm64' }).resolveTraefikTarget();
  assert.deepEqual(linuxArm64, {
    platform: 'linux',
    arch: 'arm64',
    archiveExt: 'tar.gz',
    executableName: 'traefik',
  });

  const darwinArm64 = new PlatformEnvironment({ platform: 'darwin', arch: 'arm64' }).resolveTraefikTarget();
  assert.deepEqual(darwinArm64, {
    platform: 'darwin',
    arch: 'arm64',
    archiveExt: 'tar.gz',
    executableName: 'traefik',
  });

  assert.throws(
    () => new PlatformEnvironment({ platform: 'freebsd', arch: 'x64' }).resolveTraefikTarget(),
    /Unsupported platform for Traefik/,
  );
  assert.throws(
    () => new PlatformEnvironment({ platform: 'linux', arch: 's390x' }).resolveTraefikTarget(),
    /Unsupported architecture for Traefik/,
  );
});

test('parseRelease parses official Traefik releases with target platform and arch', () => {
  const releaseData = {
    tag_name: 'v3.7.17',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'traefik_v3.7.17_windows_amd64.zip',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_windows_amd64.zip',
      },
      {
        name: 'traefik_v3.7.17_linux_arm64.tar.gz',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_linux_arm64.tar.gz',
      },
      {
        name: 'traefik_v3.7.17_checksums.txt',
        browser_download_url: 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_checksums.txt',
      },
    ],
  };

  const defaultRelease = parseRelease(releaseData, {
    platform: 'windows', arch: 'amd64', archiveExt: 'zip', executableName: 'traefik.exe',
  });
  assert.equal(defaultRelease.version, '3.7.17');
  assert.equal(defaultRelease.archiveName, 'traefik_v3.7.17_windows_amd64.zip');
  assert.equal(defaultRelease.archiveUrl, 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_windows_amd64.zip');
  assert.equal(defaultRelease.checksumUrl, 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_checksums.txt');

  const linuxRelease = parseRelease(releaseData, {
    platform: 'linux',
    arch: 'arm64',
    archiveExt: 'tar.gz',
    executableName: 'traefik',
  });
  assert.equal(linuxRelease.version, '3.7.17');
  assert.equal(linuxRelease.archiveName, 'traefik_v3.7.17_linux_arm64.tar.gz');
  assert.equal(linuxRelease.archiveUrl, 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_linux_arm64.tar.gz');
  assert.equal(linuxRelease.checksumUrl, 'https://github.com/traefik/traefik/releases/download/v3.7.17/traefik_v3.7.17_checksums.txt');
});
