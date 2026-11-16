import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_SETTINGS, resolveSettings, withSettingValue,
  type BrcSettings, type BrcSettingKey, type SettingsStorePort,
} from 'brc-shared';
import { parseEditableValue, type ConfigFieldKey } from '../../core/config-field-definitions.js';
import type { ConfigStorage } from './config-storage.js';
import { resolveAgentPaths, type AgentPaths } from './agent-paths.js';

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  telemetryEnabled?: boolean;
  fileWriteLineLimit?: number;
  fileReadLineLimit?: number;
  commandTimeoutMs?: number;
  clientId?: string;
  currentClient?: { name: string; version: string };
  [key: string]: unknown;
}

export interface AgentConfigOptions {
  paths?: AgentPaths;
  env?: NodeJS.ProcessEnv;
  legacyDirectory?: string;
}

const requireFromHere = createRequire(import.meta.url);
const yaml = requireFromHere('js-yaml') as {
  safeLoad(contents: string): unknown;
  safeDump(value: unknown, options: { noRefs: boolean }): string;
};

const fields = {
  blockedCommands: 'agent.blockedCommands',
  allowedDirectories: 'agent.allowedDirectories',
  defaultShell: 'agent.defaultShell',
  telemetryEnabled: 'agent.telemetry.enabled',
  fileWriteLineLimit: 'agent.fileWriteLineLimit',
  fileReadLineLimit: 'agent.fileReadLineLimit',
  commandTimeoutMs: 'agent.commandTimeoutMs',
} as const satisfies Record<string, BrcSettingKey>;

type ConfigurableKey = keyof typeof fields;
const hasField = (key: string): key is ConfigurableKey => Object.hasOwn(fields, key);
const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);

function fieldValue(settings: BrcSettings, key: ConfigurableKey): unknown {
  switch (key) {
    case 'telemetryEnabled': return settings.agent.telemetry.enabled;
    default: return settings.agent[key];
  }
}

function normaliseTelemetryEnabled(value: unknown): unknown {
  return typeof value === 'string' && /^(true|false)$/i.test(value.trim())
    ? value.trim().toLowerCase() === 'true' : value;
}
export const normalizeTelemetryEnabledValue = normaliseTelemetryEnabled;
export const isTelemetryDisabledValue = (value: unknown): boolean => normaliseTelemetryEnabled(value) === false;

export function resolveAgentSettings(settings: BrcSettings, env: NodeJS.ProcessEnv): BrcSettings {
  const enabled = resolveSettings(settings, { BRC_DIAGNOSTICS_ENABLED: env.BRC_DIAGNOSTICS_ENABLED }).settings.diagnostics.enabled;
  if (enabled) return resolveSettings(settings, env).settings;
  const filtered = { ...env };
  delete filtered.BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS;
  delete filtered.BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS;
  delete filtered.BRC_DIAGNOSTICS_MAX_RECORD_BYTES;
  delete filtered.BRC_DIAGNOSTICS_RETENTION_DAYS;
  return resolveSettings(settings, filtered).settings;
}

function hasExplicitYamlKey(document: unknown, key: BrcSettingKey): boolean {
  let current: unknown = document;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

export class AgentConfigManager {
  private readonly options: AgentConfigOptions;
  private readonly paths: AgentPaths;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly settingsStore: SettingsStorePort,
    private readonly stateStorage: ConfigStorage,
    private readonly usageStorage: ConfigStorage,
    options: AgentConfigOptions = {},
  ) {
    this.options = options;
    const env = options.env ?? process.env;
    this.paths = options.paths ?? resolveAgentPaths(env);
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.load().catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async load(): Promise<void> {
    await this.settingsStore.read();
    await this.readState();
    const runtimeEnv = this.options.env ?? process.env;
    const defaultRoot = resolveAgentPaths({ ...runtimeEnv, BRC_DATA_ROOT: undefined }).root;
    const eligible = path.normalize(this.paths.root).toLowerCase() === path.normalize(defaultRoot).toLowerCase();
    const legacyDirectory = this.options.legacyDirectory ?? (eligible ? this.paths.legacyDirectory : undefined);
    if (legacyDirectory) await this.migrateLegacy(path.join(legacyDirectory, 'config.json'));
  }

  private async readState(): Promise<ServerConfig> {
    return this.readDocument(this.stateStorage);
  }

  private async readUsage(): Promise<ServerConfig> {
    return this.readDocument(this.usageStorage);
  }

  private async readDocument(storage: ConfigStorage): Promise<ServerConfig> {
    try {
      return await storage.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async readSettings(): Promise<BrcSettings> {
    const { settings } = await this.settingsStore.read();
    return resolveAgentSettings(settings, this.options.env ?? process.env);
  }

  private async updateState(mutate: (data: ServerConfig) => unknown): Promise<unknown> {
    return this.updateDocument(this.stateStorage, mutate);
  }

  private async updateUsage(mutate: (data: ServerConfig) => unknown): Promise<unknown> {
    return this.updateDocument(this.usageStorage, mutate);
  }

  private async updateDocument(storage: ConfigStorage, mutate: (data: ServerConfig) => unknown): Promise<unknown> {
    await storage.prepare();
    const release = await storage.lock();
    try {
      const state = await this.readDocument(storage);
      const value = mutate(state);
      await storage.write(state);
      return clone(value);
    } finally {
      await release();
    }
  }

  private async migrateLegacy(filename: string): Promise<void> {
    let legacy: ServerConfig;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Legacy Agent config must be a plain file.');
      const document: unknown = JSON.parse(await readFile(filename, 'utf8'));
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Legacy Agent configuration is not an object.');
      legacy = document as ServerConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const existing = await this.settingsStore.read();
    const document = existing.revision === null ? {} : yaml.safeLoad(await readFile(this.paths.configFile, 'utf8'));
    const migrateSettings = Object.entries(fields)
      .filter(([name, key]) => Object.hasOwn(legacy, name) && !hasExplicitYamlKey(document, key))
      .map(([name, key]) => ({ key: key as BrcSettingKey, value: legacy[name] }));
    if (migrateSettings.length) {
      await this.settingsStore.update((settings) => {
        let updated = settings;
        for (const entry of migrateSettings) {
          const value = entry.key === 'agent.telemetry.enabled' ? normaliseTelemetryEnabled(entry.value) : entry.value;
          updated = withSettingValue(updated, entry.key, value as never);
        }
        return updated;
      });
    }
    const extraState = Object.fromEntries(Object.entries(legacy).filter(([key]) => !hasField(key) && key !== 'version' && key !== 'usageStats'));
    if (legacy.usageStats !== undefined) {
      await this.updateUsage((usage) => {
        if (!Object.hasOwn(usage, 'usageStats')) usage.usageStats = legacy.usageStats;
      });
    }
    if (Object.keys(extraState).length) {
      await this.updateState((state) => {
        for (const [key, value] of Object.entries(extraState)) if (!Object.hasOwn(state, key)) state[key] = value;
      });
    }
    await this.settingsStore.read();
    await this.readState();
    await unlink(filename);
  }

  async getConfig(): Promise<ServerConfig> {
    await this.init();
    const settings = await this.readSettings();
    return clone({
      ...(await this.readState()),
      ...(await this.readUsage()),
      blockedCommands: settings.agent.blockedCommands,
      allowedDirectories: settings.agent.allowedDirectories,
      defaultShell: settings.agent.defaultShell,
      telemetryEnabled: settings.agent.telemetry.enabled,
      fileReadLineLimit: settings.agent.fileReadLineLimit,
      fileWriteLineLimit: settings.agent.fileWriteLineLimit,
      commandTimeoutMs: settings.agent.commandTimeoutMs,
    });
  }

  async getValue(key: string): Promise<any> {
    return clone((await this.getConfig())[key]);
  }

  async setUserSetting(key: ConfigFieldKey, raw: unknown): Promise<void> {
    await this.setValue(key, parseEditableValue(key, raw));
  }

  async setValue(key: string, value: unknown): Promise<void> {
    await this.init();
    if (key === 'usageStats') {
      await this.updateUsage((state) => { state.usageStats = clone(value); });
      return;
    }
    if (hasField(key)) {
      const canonical = fields[key];
      await this.settingsStore.update((settings) =>
        withSettingValue(settings, canonical, (key === 'telemetryEnabled' ? normaliseTelemetryEnabled(value) : clone(value)) as never));
      return;
    }
    await this.updateState((state) => { state[key] = clone(value); });
  }

  async updateValue(key: string, updater: (value: any) => any): Promise<any> {
    await this.init();
    if (key === 'usageStats') {
      return this.updateUsage((state) => {
        const next = updater(clone(state.usageStats));
        state.usageStats = clone(next);
        return next;
      });
    }
    if (hasField(key)) {
      let next: unknown;
      await this.settingsStore.update((settings) => {
        next = updater(clone(fieldValue(settings, key)));
        return withSettingValue(settings, fields[key], next as never);
      });
      return clone(next);
    }
    return this.updateState((state) => {
      const next = updater(clone(state[key]));
      state[key] = clone(next);
      return next;
    });
  }

  async setValueNonBlocking(key: string, value: unknown): Promise<void> {
    await this.setValue(key, value);
  }

  async updateValueNonBlocking(key: string, updater: (value: any) => any): Promise<any> {
    return this.updateValue(key, updater);
  }

  async updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig> {
    await this.init();
    for (const [key, value] of Object.entries(updates)) await this.setValue(key, value);
    return this.getConfig();
  }

  async resetConfig(): Promise<ServerConfig> {
    await this.init();
    await this.settingsStore.update((settings) => ({ ...settings, agent: structuredClone(DEFAULT_SETTINGS.agent) }));
    await this.updateState((data) => {
      for (const key of Object.keys(data)) delete data[key];
    });
    await this.updateUsage((data) => {
      for (const key of Object.keys(data)) delete data[key];
    });
    return this.getConfig();
  }

  isFirstRun(): boolean { return false; }

  async getOrCreateClientId(): Promise<string> {
    return (await this.updateValue('clientId', (value) => value || randomUUID())) as string;
  }
}

