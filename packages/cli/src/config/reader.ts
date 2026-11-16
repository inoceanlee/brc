import { createRequire } from 'node:module';
import path from 'node:path';
import { readSettingsText } from 'brc-shared';
import type { BrcPaths } from './paths.js';
import { resolveSettings, type ResolvedSettings } from './settings.js';

interface YamlParser {
  safeLoad(source: string): unknown;
}

const requireFromHere = createRequire(import.meta.url);

export interface LoadedSettings extends ResolvedSettings {
  rawContents: string | null;
}

export class InvalidConfigurationFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidConfigurationFileError';
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function readConfigFile(filename: string, env: NodeJS.ProcessEnv): Promise<LoadedSettings> {
  const rawContents = await readSettingsText(filename);
  const yaml = requireFromHere('js-yaml') as YamlParser;
  let document: unknown;
  try {
    document = yaml.safeLoad(rawContents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidConfigurationFileError(`Invalid YAML in ${filename}: ${detail}`, { cause: error });
  }

  try {
    resolveSettings(document, {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidConfigurationFileError(`Invalid configuration in ${filename}: ${detail}`, { cause: error });
  }
  try {
    return { ...resolveSettings(document, env), rawContents };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid environment configuration for ${filename}: ${detail}`, { cause: error });
  }
}

export async function readSettings(paths: BrcPaths, env: NodeJS.ProcessEnv): Promise<LoadedSettings> {
  const filename = path.join(paths.config, 'brc.yaml');
  try {
    return await readConfigFile(filename, env);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return { ...resolveSettings({ version: 1 }, env), rawContents: null };
  }
}

export async function readLastGoodSettings(paths: BrcPaths, env: NodeJS.ProcessEnv): Promise<LoadedSettings | null> {
  const filename = path.join(paths.config, 'brc.yaml.last-good');
  try {
    return await readConfigFile(filename, env);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return null;
  }
}
