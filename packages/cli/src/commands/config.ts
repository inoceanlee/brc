import path from 'node:path';
import type { BrcPaths } from '../config/paths.js';
import { isBrcSettingKey, parseSettingArgument } from '../config/settings.js';
import { SettingsManager } from '../config/manager.js';

export interface ConfigCommandDependencies {
  manager: SettingsManager;
  paths: BrcPaths;
  write: (message: string) => void;
  json?: boolean;
}

class ConfigUsageError extends Error {
  readonly exitCode = 2;
}

function usageError(): Error {
  return new ConfigUsageError('Usage: brc config <show|get|set|apply|path> [key] [value].');
}

export async function runConfigCommand(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<number> {
  const [command, keyArgument, valueArgument] = args;
  switch (command) {
    case 'show': {
      if (args.length !== 1) throw usageError();
      const entries = dependencies.manager.entries();
      if (dependencies.json) {
        dependencies.write(JSON.stringify({ entries }));
        return 0;
      }
      const rows = entries.map(({ key, value, source }) => `${key} = ${value} (${source})`);
      dependencies.write(rows.join('\n'));
      return 0;
    }
    case 'get': {
      if (args.length !== 2 || !keyArgument || !isBrcSettingKey(keyArgument)) throw usageError();
      const { value, source } = dependencies.manager.get(keyArgument);
      dependencies.write(dependencies.json ? JSON.stringify({ key: keyArgument, value, source }) : `${keyArgument} = ${value} (${source})`);
      return 0;
    }
    case 'set': {
      if (args.length !== 3 || !keyArgument || valueArgument === undefined || !isBrcSettingKey(keyArgument)) throw usageError();
      const value = parseSettingArgument(keyArgument, valueArgument);
      const result = await dependencies.manager.set(keyArgument, value);
      const effective = dependencies.manager.get(keyArgument);
      const guidance = result.restartRequired ? ' Restart the affected service for static changes to take effect.' : '';
      dependencies.write(`${keyArgument} = ${effective.value} (${effective.source}).${guidance}`);
      return 0;
    }
    case 'apply': {
      if (args.length !== 1) throw usageError();
      const result = await dependencies.manager.apply();
      dependencies.write(result.restartRequired
        ? 'Configuration applied. Restart affected services for static changes to take effect.'
        : 'Configuration applied.');
      return 0;
    }
    case 'path': {
      if (args.length !== 1) throw usageError();
      const file = path.join(dependencies.paths.config, 'brc.yaml');
      dependencies.write(dependencies.json ? JSON.stringify({ path: file }) : file);
      return 0;
    }
    default:
      throw usageError();
  }
}
