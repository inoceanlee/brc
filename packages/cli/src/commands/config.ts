import path from 'node:path';
import { cliSuccess, type CliResult } from 'brc-shared';
import type { BrcPaths } from '../config/paths.js';
import { isBrcSettingKey, parseSettingArgument } from '../config/settings.js';
import { SettingsManager } from '../config/manager.js';

export interface ConfigCommandDependencies {
  manager: SettingsManager;
  paths: BrcPaths;
  preview?: boolean;
  signal?: AbortSignal;
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
): Promise<CliResult> {
  const [command, keyArgument, valueArgument] = args;
  switch (command) {
    case 'show': {
      if (args.length !== 1) throw usageError();
      return cliSuccess(dependencies.manager.entries());
    }
    case 'get': {
      if (args.length !== 2 || !keyArgument || !isBrcSettingKey(keyArgument)) throw usageError();
      const { value, source } = dependencies.manager.get(keyArgument);
      return cliSuccess({ key: keyArgument, value, source });
    }
    case 'set': {
      if (args.length !== 3 || !keyArgument || valueArgument === undefined || !isBrcSettingKey(keyArgument)) throw usageError();
      const value = parseSettingArgument(keyArgument, valueArgument);
      if (dependencies.preview) {
        const current = dependencies.manager.get(keyArgument);
        return cliSuccess({ preview: true, changes: [{ key: keyArgument, from: current.value, to: value }] });
      }
      const result = await dependencies.manager.set(keyArgument, value, dependencies.signal);
      const effective = dependencies.manager.get(keyArgument);
      return cliSuccess({
        key: keyArgument,
        value: effective.value,
        source: effective.source,
        restartRequired: result.restartRequired,
      });
    }
    case 'apply': {
      if (args.length !== 1) throw usageError();
      if (dependencies.preview) {
        return cliSuccess({ preview: true, changes: await dependencies.manager.previewApply(dependencies.signal) });
      }
      const result = await dependencies.manager.apply(dependencies.signal);
      return cliSuccess({ applied: true, restartRequired: result.restartRequired });
    }
    case 'path': {
      if (args.length !== 1) throw usageError();
      return cliSuccess({ path: path.join(dependencies.paths.config, 'brc.yaml') });
    }
    default:
      throw usageError();
  }
}
