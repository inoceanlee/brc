import { PlatformEnvironment, type PlatformTarget } from '../../config/platform-environment.js';
import type { TraefikRelease } from '../../core/traefik/rules.js';

export type { PlatformTarget };

export function parseRelease(value: unknown, target?: PlatformTarget): TraefikRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Official Traefik release metadata is malformed.');
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
    throw new Error('The latest Traefik release is not a stable release.');
  }
  const match = release.tag_name.match(/^v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Official Traefik release tag is invalid: ${release.tag_name}`);
  const version = match[1];
  const resolvedTarget = target ?? new PlatformEnvironment().resolveTraefikTarget();
  const archiveName = `traefik_v${version}_${resolvedTarget.platform}_${resolvedTarget.arch}.${resolvedTarget.archiveExt}`;
  const checksumName = `traefik_v${version}_checksums.txt`;
  if (!Array.isArray(release.assets)) throw new Error('Official Traefik release has no asset list.');
  const assets = release.assets as unknown[];
  const findAsset = (name: string): string => {
    const asset = assets.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === name) as Record<string, unknown> | undefined;
    const url = asset?.browser_download_url;
    const expected = `https://github.com/traefik/traefik/releases/download/v${version}/${name}`;
    if (url !== expected) throw new Error(`Official Traefik asset is missing or has an unexpected URL: ${name}`);
    return expected;
  };
  return { version, archiveName, archiveUrl: findAsset(archiveName), checksumUrl: findAsset(checksumName) };
}
