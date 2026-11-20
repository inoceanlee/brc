import type { BrcSettings } from '../../config/settings.js';

export interface VersionManifest {
  version: 1;
  current: string;
  previous: string | null;
}

export interface TraefikRelease {
  version: string;
  archiveUrl: string;
  checksumUrl: string;
  archiveName: string;
}

export interface TraefikTemplates {
  staticConfig: string;
  dynamicConfig: string;
}

export interface ArchiveEntryLike {
  path: string;
  type: string;
  uncompressedSize: number;
}

export const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

export function parseManifest(value: unknown): VersionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Traefik version manifest is malformed.');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !isVersion(manifest.current)
    || !(manifest.previous === null || isVersion(manifest.previous))
    || manifest.previous === manifest.current) {
    throw new Error('Traefik version manifest is malformed.');
  }
  return { version: 1, current: manifest.current, previous: manifest.previous };
}

export function safeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
  const segments = value.endsWith('/') ? value.slice(0, -1).split('/') : value.split('/');
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function quoteYaml(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

export function renderTemplate(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) result = result.replaceAll(placeholder, value);
  if (/@@BRC_[A-Z_]+@@/.test(result)) throw new Error('Traefik configuration has an unresolved template value.');
  return result;
}

export function renderConfig({ templates, dynamicSettings, staticSettings, dynamicPath, generation }: {
  templates: TraefikTemplates;
  dynamicSettings: Readonly<BrcSettings>;
  staticSettings: Readonly<BrcSettings>;
  dynamicPath: string;
  generation: string;
}): TraefikTemplates {
  return {
    dynamicConfig: renderTemplate(templates.dynamicConfig, {
      '@@BRC_RELAY_URL@@': quoteYaml(`http://127.0.0.1:${dynamicSettings.services.relayPort}`),
      '@@BRC_RATE_AVERAGE@@': String(dynamicSettings.proxy.rate.average),
      '@@BRC_RATE_PERIOD@@': quoteYaml(dynamicSettings.proxy.rate.period),
      '@@BRC_RATE_BURST@@': String(dynamicSettings.proxy.rate.burst),
      '@@BRC_CONCURRENT@@': String(dynamicSettings.proxy.concurrent),
      '@@BRC_CONFIG_GENERATION@@': quoteYaml(generation),
    }),
    staticConfig: renderTemplate(templates.staticConfig, {
      '@@BRC_WEB_ADDRESS@@': quoteYaml(`127.0.0.1:${staticSettings.services.proxyPort}`),
      '@@BRC_HEALTH_ADDRESS@@': quoteYaml(`127.0.0.1:${staticSettings.services.healthPort}`),
      '@@BRC_DYNAMIC_FILE@@': quoteYaml(dynamicPath),
    }),
  };
}

export function readChecksum(contents: string, filename: string): string {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f\d]{64})\s+\*?(.+)$/i);
    if (match?.[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`Official Traefik checksum file does not contain ${filename}.`);
}

export function validateArchiveEntries(entries: ArchiveEntryLike[]): ArchiveEntryLike {
  const names = new Set<string>();
  let executable: ArchiveEntryLike | undefined;
  for (const entry of entries) {
    if (!safeArchivePath(entry.path)) throw new Error(`Traefik ZIP contains an unsafe path: ${entry.path}`);
    if (names.has(entry.path)) throw new Error(`Traefik ZIP contains a duplicate path: ${entry.path}`);
    names.add(entry.path);
    if (entry.path === 'traefik.exe' && entry.type === 'File') executable = entry;
  }
  const size = executable?.uncompressedSize;
  if (!executable || typeof size !== 'number' || size < 1 || size > MAX_EXECUTABLE_BYTES) {
    throw new Error('Traefik ZIP does not contain a valid root-level traefik.exe.');
  }
  return executable;
}

export function verifyChecksum(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Official Traefik ZIP SHA-256 checksum does not match.');
}
