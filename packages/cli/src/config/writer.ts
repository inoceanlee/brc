import { createRequire } from 'node:module';
import { removeSettingsFile, writeSettingsText } from 'brc-shared';
import path from 'node:path';
import type { BrcPaths } from './paths.js';
import type { BrcSettings } from './settings.js';

interface YamlSerializer {
  safeDump(value: unknown, options: { noRefs: boolean }): string;
}

const requireFromHere = createRequire(import.meta.url);

export function serializeSettings(settings: Readonly<BrcSettings>): string {
  const yaml = requireFromHere('js-yaml') as YamlSerializer;
  return yaml.safeDump(settings, { noRefs: true });
}


export async function writeConfigText(paths: BrcPaths, contents: string): Promise<void> {
  await writeSettingsText(path.join(paths.config, 'brc.yaml'), contents);
}

export async function writeLastGoodText(paths: BrcPaths, contents: string): Promise<void> {
  await writeSettingsText(path.join(paths.config, 'brc.yaml.last-good'), contents);
}

export async function removeConfigFile(paths: BrcPaths): Promise<void> {
  await removeSettingsFile(path.join(paths.config, 'brc.yaml'));
}

export async function removeLastGoodFile(paths: BrcPaths): Promise<void> {
  await removeSettingsFile(path.join(paths.config, 'brc.yaml.last-good'));
}

export async function writeSettings(paths: BrcPaths, settings: Readonly<BrcSettings>): Promise<string> {
  const contents = serializeSettings(settings);
  await writeConfigText(paths, contents);
  return contents;
}
