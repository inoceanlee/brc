import { DEFAULT_MANAGED_LOG_MAX_BYTES } from 'brc-shared';

export interface BrcSettings {
  version: 1;
  proxy: {
    rate: {
      average: number;
      period: string;
      burst: number;
    };
    concurrent: number;
  };
  services: {
    relayPort: number;
    proxyPort: number;
    healthPort: number;
    publicUrl: string;
  };
  logs: {
    retentionDays: number;
    maxTotalMiB: number;
    rotateMiB: number;
  };
  audit: {
    retentionDays: number;
    maxEntries: number;
  };
  runtime: {
    startupTimeoutMs: number;
    shutdownTimeoutMs: number;
    lockWaitMs: number;
    lockPollMs: number;
  };
}

export interface BrcSettingValues {
  'proxy.rate.average': number;
  'proxy.rate.period': string;
  'proxy.rate.burst': number;
  'proxy.concurrent': number;
  'services.relayPort': number;
  'services.proxyPort': number;
  'services.healthPort': number;
  'services.publicUrl': string;
  'logs.retentionDays': number;
  'logs.maxTotalMiB': number;
  'logs.rotateMiB': number;
  'audit.retentionDays': number;
  'audit.maxEntries': number;
  'runtime.startupTimeoutMs': number;
  'runtime.shutdownTimeoutMs': number;
  'runtime.lockWaitMs': number;
  'runtime.lockPollMs': number;
}

export type BrcSettingKey = keyof BrcSettingValues;
export type BrcSettingSource = 'environment' | 'file' | 'default';
export type BrcSettingSources = Readonly<Record<BrcSettingKey, BrcSettingSource>>;

export const BRC_SETTING_KEYS = [
  'proxy.rate.average',
  'proxy.rate.period',
  'proxy.rate.burst',
  'proxy.concurrent',
  'services.relayPort',
  'services.proxyPort',
  'services.healthPort',
  'services.publicUrl',
  'logs.retentionDays',
  'audit.retentionDays',
  'audit.maxEntries',
  'logs.maxTotalMiB',
  'logs.rotateMiB',
  'runtime.startupTimeoutMs',
  'runtime.shutdownTimeoutMs',
  'runtime.lockWaitMs',
  'runtime.lockPollMs',
] as const satisfies readonly BrcSettingKey[];

export const SETTING_ENVIRONMENT_KEYS: Readonly<Record<BrcSettingKey, string>> = Object.freeze({
  'proxy.rate.average': 'BRC_PROXY_RATE_AVERAGE',
  'proxy.rate.period': 'BRC_PROXY_RATE_PERIOD',
  'proxy.rate.burst': 'BRC_PROXY_RATE_BURST',
  'proxy.concurrent': 'BRC_PROXY_CONCURRENT',
  'services.relayPort': 'BRC_RELAY_PORT',
  'services.proxyPort': 'BRC_TRAEFIK_PORT',
  'services.healthPort': 'BRC_TRAEFIK_HEALTH_PORT',
  'services.publicUrl': 'BRC_PUBLIC_URL',
  'logs.retentionDays': 'BRC_LOG_RETENTION_DAYS',
  'audit.retentionDays': 'BRC_AUDIT_RETENTION_DAYS',
  'audit.maxEntries': 'BRC_AUDIT_MAX_ENTRIES',
  'logs.maxTotalMiB': 'BRC_LOG_MAX_TOTAL_MIB',
  'logs.rotateMiB': 'BRC_LOG_ROTATE_MIB',
  'runtime.startupTimeoutMs': 'BRC_RUNTIME_STARTUP_TIMEOUT_MS',
  'runtime.shutdownTimeoutMs': 'BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS',
  'runtime.lockWaitMs': 'BRC_RUNTIME_LOCK_WAIT_MS',
  'runtime.lockPollMs': 'BRC_RUNTIME_LOCK_POLL_MS',
});

/** Internal health-check policy; independent from the user-controlled service startup deadline. */
export const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
export const HEALTH_RETRY_COUNT = 2;
export const IDENTITY_INSPECTION_RETRY_COUNT = 1;
export const TRAEFIK_RELEASE_LOOKUP_ATTEMPTS = 2;
export const TRAEFIK_RELEASE_RETRY_DELAY_MS = 1_000;

export const DEFAULT_SETTINGS: Readonly<BrcSettings> = Object.freeze({
  version: 1,
  proxy: Object.freeze({
    rate: Object.freeze({ average: 10, period: '1s', burst: 30 }),
    concurrent: 16,
  }),
  services: Object.freeze({ relayPort: 3000, proxyPort: 13001, healthPort: 13002, publicUrl: '' }),
  logs: Object.freeze({ retentionDays: 7, maxTotalMiB: 50, rotateMiB: DEFAULT_MANAGED_LOG_MAX_BYTES / (1024 * 1024) }),
  audit: Object.freeze({ retentionDays: 30, maxEntries: 50_000 }),
  runtime: Object.freeze({ startupTimeoutMs: 15_000, shutdownTimeoutMs: 3_000, lockWaitMs: 3_000, lockPollMs: 50 }),
});

export interface ResolvedSettings {
  settings: BrcSettings;
  fileSettings: BrcSettings;
  sources: BrcSettingSources;
}

const settingKeySet = new Set<string>(BRC_SETTING_KEYS);


function copySettings(settings: Readonly<BrcSettings>): BrcSettings {
  return {
    version: settings.version,
    proxy: {
      rate: { ...settings.proxy.rate },
      concurrent: settings.proxy.concurrent,
    },
    services: { ...settings.services },
    logs: { ...settings.logs },
    audit: { ...settings.audit },
    runtime: { ...settings.runtime },
  };
}

function applySettingValue(settings: BrcSettings, key: BrcSettingKey, value: number | string): void {
  const [section, ...parts] = key.split('.');
  let target = settings[section as keyof BrcSettings] as unknown as Record<string, unknown>;
  for (let index = 0; index < parts.length - 1; index += 1) {
    target = target[parts[index]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
}

export function withSettingValue<K extends BrcSettingKey>(
  settings: Readonly<BrcSettings>,
  key: K,
  value: BrcSettingValues[K],
): BrcSettings {
  const copy = copySettings(settings);
  applySettingValue(copy, key, value);
  return copy;
}

function validateSettingValue(key: BrcSettingKey, value: unknown): number | string {
  if (key === 'services.publicUrl') {
    if (typeof value !== 'string') throw new Error('services.publicUrl must be a URL string.');
    if (value === '') return value;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.origin !== value) {
        throw new Error('invalid');
      }
    } catch { throw new Error('services.publicUrl must be an absolute HTTP(S) origin without a path, credentials, query or fragment.'); }
    return value;
  }
  if (key === 'proxy.rate.period') {
    if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?)(?:ms|s|m|h)$/.test(value) || Number.parseFloat(value) <= 0) {
      throw new Error(`${key} must be a positive duration such as 1s.`);
    }
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  if (key === 'proxy.rate.average') {
    if (value <= 0) throw new Error(`${key} must be greater than zero.`);
    return value;
  }
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer.`);
  if (key === 'services.relayPort' || key === 'services.proxyPort' || key === 'services.healthPort') {
    if (value < 1 || value > 65535) throw new Error(`${key} must be an integer from 1 to 65535.`);
    return value;
  }
  if (key === 'logs.retentionDays' || key === 'audit.retentionDays') {
    if (value < 0) throw new Error(`${key} must be zero or greater.`);
    return value;
  }
  if (key === 'audit.maxEntries') {
    if (value < 1 || value > DEFAULT_SETTINGS.audit.maxEntries) {
      throw new Error(`${key} must be an integer from 1 to ${DEFAULT_SETTINGS.audit.maxEntries}.`);
    }
    return value;
  }
  if (value < 1) throw new Error(`${key} must be greater than zero.`);
  return value;
}

function collectFileValues(document: unknown): Map<BrcSettingKey, unknown> {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('Configuration YAML must contain a mapping.');
  }
  if ((document as Record<string, unknown>).version !== 1) {
    throw new Error('Configuration version must be 1.');
  }
  const values = new Map<BrcSettingKey, unknown>();
  const active = new WeakSet<object>();
  const visit = (record: Record<string, unknown>, prefix = '') => {
    if (active.has(record)) throw new Error('Configuration YAML contains a cyclic alias.');
    active.add(record);
    try {
      for (const [name, value] of Object.entries(record)) {
        const fullName = prefix ? `${prefix}.${name}` : name;
        if (fullName === 'version') {
          if (value !== 1) throw new Error('Configuration version must be 1.');
          continue;
        }
        if (settingKeySet.has(fullName)) {
          values.set(fullName as BrcSettingKey, value);
          continue;
        }
        if (!BRC_SETTING_KEYS.some((key) => key.startsWith(`${fullName}.`))) {
          throw new Error(`Unknown configuration key: ${fullName}`);
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`${fullName} must be a mapping.`);
        }
        visit(value as Record<string, unknown>, fullName);
      }
    } finally {
      active.delete(record);
    }
  };
  visit(document as Record<string, unknown>);
  return values;
}

function parseEnvironmentValue(key: BrcSettingKey, value: string): number | string {
  if (key === 'proxy.rate.period' || key === 'services.publicUrl') return validateSettingValue(key, value);
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(value.trim())) throw new Error(`${SETTING_ENVIRONMENT_KEYS[key]} must be a number.`);
  return validateSettingValue(key, Number(value));
}

function assertCrossFieldConstraints(settings: Readonly<BrcSettings>): void {
  const { relayPort, proxyPort, healthPort } = settings.services;
  if (relayPort === proxyPort || relayPort === healthPort || proxyPort === healthPort) {
    throw new Error('Service ports must be different.');
  }
  if (settings.logs.rotateMiB > settings.logs.maxTotalMiB) {
    throw new Error('logs.rotateMiB cannot exceed logs.maxTotalMiB.');
  }
}

export function resolveSettings(document: unknown, env: NodeJS.ProcessEnv): ResolvedSettings {
  const fileValues = collectFileValues(document);
  const fileSettings = copySettings(DEFAULT_SETTINGS);
  for (const key of BRC_SETTING_KEYS) {
    if (fileValues.has(key)) {
      applySettingValue(fileSettings, key, validateSettingValue(key, fileValues.get(key)));
    }
  }
  assertCrossFieldConstraints(fileSettings);

  const settings = copySettings(fileSettings);
  const sources = {} as Record<BrcSettingKey, BrcSettingSource>;
  for (const key of BRC_SETTING_KEYS) {
    const environmentName = SETTING_ENVIRONMENT_KEYS[key];
    const environmentValue = env[environmentName];
    if (environmentValue !== undefined) {
      const value = parseEnvironmentValue(key, environmentValue);
      applySettingValue(settings, key, value);
      sources[key] = 'environment';
    } else {
      sources[key] = fileValues.has(key) ? 'file' : 'default';
    }
  }
  assertCrossFieldConstraints(settings);
  return { settings, fileSettings, sources };
}

export function parseSettingArgument<K extends BrcSettingKey>(key: K, value: string): BrcSettingValues[K] {
  if (key !== 'proxy.rate.period' && key !== 'services.publicUrl' && !/^-?(?:\d+)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${key} must be a number.`);
  }
  return validateSettingValue(key, key === 'proxy.rate.period' || key === 'services.publicUrl' ? value : Number(value)) as BrcSettingValues[K];
}

export function isBrcSettingKey(value: string): value is BrcSettingKey {
  return settingKeySet.has(value);
}
