import type { BrcSettings } from './settings.js';

export interface SettingsSnapshot {
  settings: BrcSettings;
  revision: string | null;
}

export interface SettingsStorePort {
  read(): Promise<SettingsSnapshot>;
  write(settings: Readonly<BrcSettings>, expectedRevision?: string | null): Promise<SettingsSnapshot>;
  update(mutator: (settings: BrcSettings) => BrcSettings | void, signal?: AbortSignal): Promise<SettingsSnapshot>;
  watch(listener: () => void): () => void;
}
