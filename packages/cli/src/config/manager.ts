import type { BrcPaths } from './paths.js';
import {
  BRC_SETTING_KEYS,
  isBrcSettingKey,
  resolveSettings,
  withSettingValue,
  type BrcSettingKey,
  type BrcSettingSource,
  type BrcSettingValues,
  type BrcSettings,
} from './settings.js';
import {
  InvalidConfigurationFileError,
  readLastGoodSettings,
  readSettings,
  type LoadedSettings,
} from './reader.js';
import {
  removeConfigFile,
  removeLastGoodFile,
  writeConfigText,
  writeLastGoodText,
  writeSettings,
} from './writer.js';
import type { LifecycleLock } from '../adapters/storage/lock.js';

export interface SettingsManagerDependencies {
  lock: Pick<LifecycleLock, 'runExclusive'>;
  /** Runs while the injected lock is held; do not acquire that lock again. */
  apply: (settings: Readonly<BrcSettings>, previous: Readonly<BrcSettings>) => Promise<void>;
}

export interface SettingEntry<K extends BrcSettingKey = BrcSettingKey> {
  key: K;
  value: BrcSettingValues[K];
  source: BrcSettingSource;
}

const STATIC_SETTINGS: readonly BrcSettingKey[] = [
  'services.relayPort',
  'services.proxyPort',
  'services.healthPort',
  'services.publicUrl',
];

function readValue<K extends BrcSettingKey>(settings: Readonly<BrcSettings>, key: K): BrcSettingValues[K] {
  let value: unknown = settings;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
  return value as BrcSettingValues[K];
}

function requiresRestart(previous: Readonly<BrcSettings>, next: Readonly<BrcSettings>): boolean {
  return STATIC_SETTINGS.some((key) => readValue(previous, key) !== readValue(next, key));
}

function defaultSettings(env: NodeJS.ProcessEnv): LoadedSettings {
  return { ...resolveSettings({ version: 1 }, env), rawContents: null };
}

export class SettingsManager {
  private constructor(
    private readonly paths: BrcPaths,
    private readonly env: NodeJS.ProcessEnv,
    private readonly dependencies: SettingsManagerDependencies,
    private loaded: LoadedSettings,
    private lastGood: LoadedSettings | null,
  ) {}

  static async load(
    paths: BrcPaths,
    env: NodeJS.ProcessEnv,
    dependencies: SettingsManagerDependencies,
  ): Promise<SettingsManager> {
    if (!dependencies?.lock || typeof dependencies.apply !== 'function') {
      throw new Error('SettingsManager requires a lifecycle lock and an apply operation.');
    }
    const runtimeEnv = { ...env };
    const readSnapshot = async () => {
      const lastGood = await readLastGoodSettings(paths, runtimeEnv);
      let loaded: LoadedSettings;
      try {
        loaded = await readSettings(paths, runtimeEnv);
      } catch (error) {
        if (!(error instanceof InvalidConfigurationFileError)) throw error;
        loaded = lastGood ?? defaultSettings(runtimeEnv);
      }
      return { loaded, lastGood };
    };
    let initial = await readSnapshot();
    // Normal reads do not mutate the filesystem and do not require the lifecycle lock.
    if (!initial.lastGood && initial.loaded.rawContents !== null) {
      initial = await dependencies.lock.runExclusive(async () => {
        const current = await readSnapshot();
        if (!current.lastGood && current.loaded.rawContents !== null) {
          await writeLastGoodText(paths, current.loaded.rawContents);
          return { ...current, lastGood: current.loaded };
        }
        return current;
      });
    }
    return new SettingsManager(paths, runtimeEnv, dependencies, initial.loaded, initial.lastGood);
  }

  get<K extends BrcSettingKey>(key: K): { value: BrcSettingValues[K]; source: BrcSettingSource } {
    return {
      value: readValue(this.loaded.settings, key),
      source: this.loaded.sources[key],
    };
  }

  entries(): SettingEntry[] {
    return BRC_SETTING_KEYS.map((key) => ({ ...this.get(key), key }));
  }
  snapshot(): Readonly<BrcSettings> {
    return structuredClone(this.loaded.settings);
  }

  async ensureConfigFile(): Promise<void> {
    await this.dependencies.lock.runExclusive(async () => {
      if (this.loaded.rawContents !== null) return;
      const current = await readSettings(this.paths, this.env);
      if (current.rawContents !== null) {
        this.loaded = current;
        return;
      }

      const contents = await writeSettings(this.paths, current.fileSettings);
      const initialized = { ...current, rawContents: contents };
      await writeLastGoodText(this.paths, contents);
      this.loaded = initialized;
      this.lastGood = initialized;
    });
  }



  async set<K extends BrcSettingKey>(key: K, value: BrcSettingValues[K]): Promise<{ restartRequired: boolean }> {
    if (!isBrcSettingKey(key)) throw new Error(`Unknown setting: ${String(key)}`);
    return this.dependencies.lock.runExclusive(async () => {
      const previous = await readLastGoodSettings(this.paths, this.env) ?? this.lastGood ?? this.loaded;
      let current: LoadedSettings;
      try {
        current = await readSettings(this.paths, this.env);
      } catch (error) {
        if (error instanceof InvalidConfigurationFileError) await this.rollback(previous, error);
        throw error;
      }
      const fileSettings = withSettingValue(current.fileSettings, key, value);
      const next = resolveSettings(fileSettings, this.env);
      const contents = await writeSettings(this.paths, next.fileSettings);
      const nextLoaded = { ...next, rawContents: contents };
      try {
        await this.dependencies.apply(next.settings, previous.settings);
        await writeLastGoodText(this.paths, contents);
      } catch (error) {
        await this.rollback(previous, error, true);
      }
      this.loaded = nextLoaded;
      this.lastGood = nextLoaded;
      return { restartRequired: requiresRestart(previous.settings, next.settings) };
    });
  }

  async apply(): Promise<{ restartRequired: boolean }> {
    return this.dependencies.lock.runExclusive(async () => {
      const previous = await readLastGoodSettings(this.paths, this.env) ?? this.lastGood ?? this.loaded;
      let next: LoadedSettings;
      try {
        next = await readSettings(this.paths, this.env);
      } catch (error) {
        if (error instanceof InvalidConfigurationFileError) await this.rollback(previous, error);
        throw error;
      }
      try {
        await this.dependencies.apply(next.settings, previous.settings);
        if (next.rawContents === null) await removeLastGoodFile(this.paths);
        else await writeLastGoodText(this.paths, next.rawContents);
      } catch (error) {
        await this.rollback(previous, error, true);
      }
      this.loaded = next;
      this.lastGood = next.rawContents === null ? null : next;
      return { restartRequired: requiresRestart(previous.settings, next.settings) };
    });
  }

  private async rollback(previous: LoadedSettings, cause: unknown, restoreRuntime = false): Promise<never> {
    const failures: unknown[] = [cause];
    if (restoreRuntime) {
      try {
        await this.dependencies.apply(previous.settings, previous.settings);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (previous.rawContents === null) {
        await removeConfigFile(this.paths);
        await removeLastGoodFile(this.paths);
      } else {
        await writeConfigText(this.paths, previous.rawContents);
        await writeLastGoodText(this.paths, previous.rawContents);
      }
    } catch (error) {
      failures.push(error);
    }
    this.loaded = previous;
    this.lastGood = previous.rawContents === null ? null : previous;
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Configuration failed and rollback was incomplete.');
    }
    throw cause;
  }
}
