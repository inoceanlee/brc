export const DEFAULT_LOG_ROTATE_BYTES = 4 * 1024 * 1024;

export const FILE_SIZE_LIMITS = Object.freeze({
  LINE_COUNT_LIMIT: 10 * 1024 * 1024,
});

export const RESOURCE_SAMPLE_INTERVAL_MIN_MS = 100;
export const RESOURCE_SAMPLE_INTERVAL_DEFAULT_MS = 1_000;
export const RESOURCE_SAMPLE_INTERVAL_MAX_MS = 60_000;
export const DIAGNOSTIC_SINGLE_SAMPLE_MAX_MS = 1_000;

export const FUNCTION_SNAPSHOT_MIN_MS = 1_000;
export const FUNCTION_SNAPSHOT_DEFAULT_MS = 10_000;
export const FUNCTION_SNAPSHOT_MAX_MS = 3_600_000;

export const DEFAULT_AGENT_FILE_READ_LINE_LIMIT = 1_000;
export const DEFAULT_AGENT_FILE_WRITE_LINE_LIMIT = 50;
export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 1_000;

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
  diagnostics: {
    enabled: boolean;
    resourceSampleMs: number;
    functionSnapshotMs: number;
    maxRecordBytes: number;
    retentionDays: number;
  };
  audit: {
    retentionDays: number;
    maxEntries: number;
  };
  agent: {
    fileReadLineLimit: number;
    fileWriteLineLimit: number;
    commandTimeoutMs: number;
    defaultShell: string;
    blockedCommands: string[];
    allowedDirectories: string[];
    telemetry: { enabled: boolean };
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
  'diagnostics.enabled': boolean;
  'diagnostics.resourceSampleMs': number;
  'diagnostics.functionSnapshotMs': number;
  'diagnostics.maxRecordBytes': number;
  'diagnostics.retentionDays': number;
  'audit.retentionDays': number;
  'audit.maxEntries': number;
  'agent.fileReadLineLimit': number;
  'agent.fileWriteLineLimit': number;
  'agent.commandTimeoutMs': number;
  'agent.defaultShell': string;
  'agent.blockedCommands': string[];
  'agent.allowedDirectories': string[];
  'agent.telemetry.enabled': boolean;
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
  'diagnostics.enabled',
  'diagnostics.resourceSampleMs',
  'diagnostics.functionSnapshotMs',
  'diagnostics.maxRecordBytes',
  'diagnostics.retentionDays',
  'agent.fileReadLineLimit',
  'agent.fileWriteLineLimit',
  'agent.commandTimeoutMs',
  'agent.defaultShell',
  'agent.blockedCommands',
  'agent.allowedDirectories',
  'agent.telemetry.enabled',
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
  'diagnostics.enabled': 'BRC_DIAGNOSTICS_ENABLED',
  'diagnostics.resourceSampleMs': 'BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS',
  'diagnostics.functionSnapshotMs': 'BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS',
  'diagnostics.maxRecordBytes': 'BRC_DIAGNOSTICS_MAX_RECORD_BYTES',
  'diagnostics.retentionDays': 'BRC_DIAGNOSTICS_RETENTION_DAYS',
  'agent.fileReadLineLimit': 'BRC_AGENT_FILE_READ_LINE_LIMIT',
  'agent.fileWriteLineLimit': 'BRC_AGENT_FILE_WRITE_LINE_LIMIT',
  'agent.commandTimeoutMs': 'BRC_AGENT_COMMAND_TIMEOUT_MS',
  'agent.defaultShell': 'BRC_AGENT_DEFAULT_SHELL',
  'agent.blockedCommands': 'BRC_AGENT_BLOCKED_COMMANDS',
  'agent.allowedDirectories': 'BRC_AGENT_ALLOWED_DIRECTORIES',
  'agent.telemetry.enabled': 'BRC_AGENT_TELEMETRY_ENABLED',
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
  logs: Object.freeze({ retentionDays: 7, maxTotalMiB: 50, rotateMiB: DEFAULT_LOG_ROTATE_BYTES / (1024 * 1024) }),
  diagnostics: Object.freeze({
    enabled: true,
    resourceSampleMs: RESOURCE_SAMPLE_INTERVAL_DEFAULT_MS,
    functionSnapshotMs: FUNCTION_SNAPSHOT_DEFAULT_MS,
    maxRecordBytes: 65_536,
    retentionDays: 7,
  }),
  audit: Object.freeze({ retentionDays: 30, maxEntries: 50_000 }),
  agent: Object.freeze({
    fileReadLineLimit: DEFAULT_AGENT_FILE_READ_LINE_LIMIT,
    fileWriteLineLimit: DEFAULT_AGENT_FILE_WRITE_LINE_LIMIT,
    commandTimeoutMs: DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
    defaultShell: '',
    blockedCommands: Object.freeze([
      'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
      'sudo', 'su', 'passwd', 'adduser', 'useradd', 'usermod', 'groupadd', 'chsh',
      'visudo', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'iptables',
      'firewall', 'netsh', 'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas',
      'cipher', 'takeown',
    ]) as unknown as string[],
    allowedDirectories: Object.freeze([]) as unknown as string[],
    telemetry: Object.freeze({ enabled: false }),
  }),
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
    diagnostics: { ...settings.diagnostics },
    audit: { ...settings.audit },
    agent: {
      ...settings.agent,
      blockedCommands: [...settings.agent.blockedCommands],
      allowedDirectories: [...settings.agent.allowedDirectories],
      telemetry: { ...settings.agent.telemetry },
    },
    runtime: { ...settings.runtime },
  };
}

function applySettingValue(settings: BrcSettings, key: BrcSettingKey, value: number | string | boolean | string[]): void {
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

function validateSettingValue(key: BrcSettingKey, value: unknown): number | string | boolean | string[] {
  if (key === 'agent.blockedCommands' || key === 'agent.allowedDirectories') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`${key} must be an array of strings.`);
    }
    return [...value] as string[];
  }
  if (key === 'agent.defaultShell') {
    if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
    return value;
  }
  if (key === 'agent.telemetry.enabled' || key === 'diagnostics.enabled') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
    return value;
  }
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
  if (key === 'diagnostics.resourceSampleMs'
      && (value < RESOURCE_SAMPLE_INTERVAL_MIN_MS || value > RESOURCE_SAMPLE_INTERVAL_MAX_MS)) {
    throw new Error(`diagnostics.resourceSampleMs must be between ${RESOURCE_SAMPLE_INTERVAL_MIN_MS} and ${RESOURCE_SAMPLE_INTERVAL_MAX_MS}.`);
  }
  if (key === 'diagnostics.functionSnapshotMs'
      && (value < FUNCTION_SNAPSHOT_MIN_MS || value > FUNCTION_SNAPSHOT_MAX_MS)) {
    throw new Error(`diagnostics.functionSnapshotMs must be between ${FUNCTION_SNAPSHOT_MIN_MS} and ${FUNCTION_SNAPSHOT_MAX_MS}.`);
  }
  if (key === 'diagnostics.maxRecordBytes' && (value < 256 || value > 65_536)) {
    throw new Error('diagnostics.maxRecordBytes must be between 256 and 65536.');
  }
  if (key === 'logs.retentionDays' || key === 'audit.retentionDays' || key === 'diagnostics.retentionDays') {
    if (value < 0) throw new Error(`${key} must be zero or greater.`);
    return value;
  }
  if (key === 'agent.fileReadLineLimit' || key === 'agent.fileWriteLineLimit') {
    if (value < 1 || value > 100_000) throw new Error(`${key} must be an integer from 1 to 100000.`);
    return value;
  }
  if (key === 'agent.commandTimeoutMs') {
    if (value < 1 || value > 3_600_000) throw new Error(`${key} must be an integer from 1 to 3600000.`);
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

function parseEnvironmentValue(key: BrcSettingKey, value: string): number | string | boolean | string[] {
  if (key === 'agent.blockedCommands' || key === 'agent.allowedDirectories') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(`${SETTING_ENVIRONMENT_KEYS[key]} must be a JSON string array.`); }
    return validateSettingValue(key, parsed);
  }
  if (key === 'agent.defaultShell') return value;
  if (key === 'agent.telemetry.enabled' || key === 'diagnostics.enabled') {
    if (!/^(true|false|1|0)$/i.test(value)) throw new Error(`${SETTING_ENVIRONMENT_KEYS[key]} must be true or false.`);
    return value.toLowerCase() === 'true' || value === '1';
  }
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
  if (settings.diagnostics.maxRecordBytes > settings.logs.rotateMiB * 1024 * 1024) {
    throw new Error('diagnostics.maxRecordBytes cannot exceed log rotation size.');
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
  if (env.DO_NOT_TRACK === '1') {
    settings.agent.telemetry.enabled = false;
    sources['agent.telemetry.enabled'] = 'environment';
  }
  assertCrossFieldConstraints(settings);
  return { settings, fileSettings, sources };
}

export function parseSettingArgument<K extends BrcSettingKey>(key: K, value: string): BrcSettingValues[K] {
  if (key === 'agent.telemetry.enabled' || key === 'diagnostics.enabled') {
    if (!/^(true|false|1|0)$/i.test(value)) throw new Error(`${key} must be true or false.`);
    return validateSettingValue(key, value.toLowerCase() === 'true' || value === '1') as BrcSettingValues[K];
  }
  if (key === 'agent.blockedCommands' || key === 'agent.allowedDirectories') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(`${key} must be a JSON array of strings.`); }
    return validateSettingValue(key, parsed) as BrcSettingValues[K];
  }
  if (key === 'agent.defaultShell') return value as BrcSettingValues[K];
  if (key !== 'proxy.rate.period' && key !== 'services.publicUrl' && !/^-?(?:\d+)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${key} must be a number.`);
  }
  return validateSettingValue(key, key === 'proxy.rate.period' || key === 'services.publicUrl' ? value : Number(value)) as BrcSettingValues[K];
}

export function isBrcSettingKey(value: string): value is BrcSettingKey {
  return settingKeySet.has(value);
}
