import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, watch as watchFile } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, resolveSettings, withSettingValue, type BrcSettingKey, type BrcSettings } from '../core/settings.js';
import type { SettingsSnapshot, SettingsStorePort } from '../core/ports.js';

export interface SettingsCodec {
  parse(source: string): unknown;
  stringify(settings: Readonly<BrcSettings>): string;
}

export interface SettingsLock {
  runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface YamlSettingsStoreOptions {
  filename: string;
  codec: SettingsCodec;
  lock: SettingsLock;
  /** Keep selected settings in the CLI last-good checkpoint without promoting unrelated pending edits. */
  backupFilename?: string;
  backupKeys?: readonly BrcSettingKey[];
}

function fileRevision(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code) : undefined;
}

export class YamlSettingsStore implements SettingsStorePort {
  constructor(private readonly options: YamlSettingsStoreOptions) {
    if (!path.isAbsolute(options.filename)) throw new Error('Settings file path must be absolute.');
    if (!options.codec || !options.lock) throw new Error('Settings store requires a codec and lock.');
  }

  async read(): Promise<SettingsSnapshot> {
    let contents: string;
    try {
      const info = await lstat(this.options.filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Settings path is not a plain file.');
      contents = await readFile(this.options.filename, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return { settings: structuredClone(DEFAULT_SETTINGS), revision: null };
    }
    const parsed = this.options.codec.parse(contents);
    const { fileSettings } = resolveSettings(parsed, {});
    return { settings: fileSettings, revision: fileRevision(contents) };
  }

  async write(settings: Readonly<BrcSettings>, expectedRevision?: string | null): Promise<SettingsSnapshot> {
    return this.options.lock.runExclusive(async () => {
      const existing = await this.read();
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new Error('Settings revision conflict.');
      }
      return this.persist(settings);
    });
  }

  async update(mutator: (settings: BrcSettings) => BrcSettings | void, signal?: AbortSignal): Promise<SettingsSnapshot> {
    return this.options.lock.runExclusive(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('Settings update cancelled.');
      const current = await this.read();
      const candidate = structuredClone(current.settings);
      const changed = mutator(candidate);
      if (signal?.aborted) throw signal.reason ?? new Error('Settings update cancelled.');
      return this.persist(changed ?? candidate);
    }, signal);
  }

  watch(listener: () => void): () => void {
    const directory = path.dirname(this.options.filename);
    mkdirSync(directory, { recursive: true });
    const basename = path.basename(this.options.filename);
    const watcher = watchFile(directory, { persistent: false }, (_event, file) => {
      if (!file || String(file) === basename) listener();
    });
    return () => watcher.close();
  }

  private async persist(settings: Readonly<BrcSettings>): Promise<SettingsSnapshot> {
    const { fileSettings } = resolveSettings(settings, {});
    const filename = this.options.filename;
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Settings directory is not a plain directory.');
    const contents = this.options.codec.stringify(fileSettings);
    await this.writeAtomic(filename, contents);
    if (this.options.backupFilename && this.options.backupKeys?.length) {
      const backup = await this.readBackup(this.options.backupFilename);
      let updated = backup;
      for (const key of this.options.backupKeys) {
        const value = key.split('.').reduce<unknown>((current, segment) =>
          (current as Record<string, unknown>)[segment], fileSettings);
        updated = withSettingValue(updated, key, value as never);
      }
      await this.writeAtomic(this.options.backupFilename, this.options.codec.stringify(updated));
    }
    return { settings: fileSettings, revision: fileRevision(contents) };
  }

  private async readBackup(filename: string): Promise<BrcSettings> {
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup settings path is not a plain file.');
      return resolveSettings(this.options.codec.parse(await readFile(filename, 'utf8')), {}).fileSettings;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private async writeAtomic(filename: string, contents: string): Promise<void> {
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
