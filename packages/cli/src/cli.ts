#!/usr/bin/env node
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConfigCommand } from './commands/config.js';
import { requestAdministrator } from './commands/setup.js';
import { resolveBrcPaths, type BrcPaths } from './config/paths.js';
import { SettingsManager } from './config/manager.js';
import { readSettings } from './config/reader.js';
import { isBrcSettingKey, parseSettingArgument, type BrcSettings } from './config/settings.js';
import { LifecycleLock } from './lifecycle/lock.js';
import { ProcessManager } from './lifecycle/processes.js';
import { createDefaultServices, ServiceManager } from './lifecycle/services.js';
import { cleanRuntime } from './maintenance/cleanup.js';
import { createMaintenanceCommands } from './commands/maintenance.js';
import { TraefikManager } from './traefik/manager.js';
import { runManagedTraefikService } from './traefik/runtime.js';
import { RelayDatabase } from './lifecycle/relay-database.js';
import { installProgressInterruptHandler, TraefikProgress } from './progress.js';

export type CliLogComponent = 'relay' | 'agent' | 'traefik';
type CommandResult = number | void;

export interface CliDependencies {
  paths: BrcPaths;
  commands: {
    setup: () => Promise<CommandResult>;
    start: () => Promise<CommandResult>;
    stop: () => Promise<CommandResult>;
    restart: () => Promise<CommandResult>;
    status: () => Promise<CommandResult>;
    logs: (component?: CliLogComponent) => Promise<CommandResult>;
    config: (args: string[]) => Promise<CommandResult>;
    updateTraefik: () => Promise<CommandResult>;
    uninstall: (options: { yes: boolean }, clean: () => Promise<void>) => Promise<CommandResult>;
  };
  clean: (paths: BrcPaths) => Promise<void>;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const HELP_TEXT = [
  'BRC unified CLI',
  '',
  'Usage: brc <command>',
  '',
  'Commands:',
  '  brc or brc help             Show status summary and command help',
  '  brc setup                   Initialize local configuration and Traefik',
  '  brc start                   Start Relay, Traefik, and Agent',
  '  brc stop                    Stop managed services',
  '  brc restart                 Restart managed services',
  '  brc status                  Show managed service status',
  '  brc logs [component]        Show recent logs',
  '  brc config <subcommand>     Show or update local settings',
  '  brc update traefik          Update Traefik',
  '  brc clean                   Run safe cleanup',
  '  brc uninstall [--yes]      Stop services and remove BRC data and package',
  '',
  'pnpm remove -g @inoceanlee/brc removes only the package and keeps BRC data.',
  'Run brc uninstall to remove BRC data and the global package.',
].join('\n');

class UsageError extends Error {
  readonly exitCode = 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorExitCode(error: unknown): number {
  if (error && typeof error === 'object' && 'exitCode' in error) {
    const exitCode = error.exitCode;
    if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) return exitCode;
  }
  return 1;
}

function isLogComponent(value: string): value is CliLogComponent {
  return value === 'relay' || value === 'agent' || value === 'traefik';
}

function requireNoExtraArgs(command: string, args: string[]): void {
  if (args.length !== 1) throw new UsageError(`The ${command} command does not accept extra arguments.`);
}

async function dispatch(args: string[], deps: CliDependencies, clean: () => Promise<void>, skipAutomaticCleanup: () => void): Promise<number> {
  const [command, ...commandArgs] = args;
  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      requireNoExtraArgs(command, args);
      deps.write(HELP_TEXT);
      return 0;
    case 'setup':
      requireNoExtraArgs(command, args);
      return (await deps.commands.setup()) ?? 0;
    case 'start':
      requireNoExtraArgs(command, args);
      return (await deps.commands.start()) ?? 0;
    case 'stop':
      requireNoExtraArgs(command, args);
      return (await deps.commands.stop()) ?? 0;
    case 'restart':
      requireNoExtraArgs(command, args);
      return (await deps.commands.restart()) ?? 0;
    case 'status':
      requireNoExtraArgs(command, args);
      return (await deps.commands.status()) ?? 0;
    case 'logs':
      if (commandArgs.length > 1 || (commandArgs[0] && !isLogComponent(commandArgs[0]))) {
        throw new UsageError('logs component must be relay, agent, or traefik.');
      }
      return (await deps.commands.logs(commandArgs[0] as CliLogComponent | undefined)) ?? 0;
    case 'config':
      return (await deps.commands.config(commandArgs)) ?? 0;
    case 'update':
      if (commandArgs.length !== 1 || commandArgs[0] !== 'traefik') {
        throw new UsageError('update accepts only the traefik target.');
      }
      return (await deps.commands.updateTraefik()) ?? 0;
    case 'clean':
      requireNoExtraArgs(command, args);
      skipAutomaticCleanup();
      await clean();
      return 0;
    case 'uninstall':
      if (commandArgs.length > 1 || (commandArgs.length === 1 && commandArgs[0] !== '--yes')) {
        throw new UsageError('uninstall accepts only the --yes option.');
      }
      skipAutomaticCleanup();
      return (await deps.commands.uninstall({ yes: commandArgs[0] === '--yes' }, clean)) ?? 0;
    default:
      throw new UsageError(`Unknown command: ${command ?? ''}. Run brc help for usage.`);
  }
}

export async function runCli(args: string[], deps: CliDependencies): Promise<number> {
  let cleanupStarted = false;
  let skipCleanup = false;
  let exitCode = 0;
  const clean = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await deps.clean(deps.paths);
  };

  try {
    if (args.length === 0) {
      try {
        exitCode = (await deps.commands.status()) ?? 0;
      } catch (error) {
        deps.writeError(`brc: ${errorMessage(error)}`);
        exitCode = errorExitCode(error);
      }
      deps.write(HELP_TEXT);
    } else {
      exitCode = await dispatch(args, deps, clean, () => { skipCleanup = true; });
    }
  } catch (error) {
    deps.writeError(`brc: ${errorMessage(error)}`);
    exitCode = errorExitCode(error);
  } finally {
    if (!skipCleanup) {
      try {
        await clean();
      } catch (error) {
        deps.writeError(`brc: cleanup failed: ${errorMessage(error)}`);
      }
    }
  }

  return exitCode;
}

const unavailable = async (): Promise<number> => {
  throw new Error('BRC service managers are not initialized.');
};
function traefikSettingsChanged(previous: Readonly<BrcSettings>, next: Readonly<BrcSettings>): boolean {
  return previous.proxy.rate.average !== next.proxy.rate.average
    || previous.proxy.rate.period !== next.proxy.rate.period
    || previous.proxy.rate.burst !== next.proxy.rate.burst
    || previous.proxy.concurrent !== next.proxy.concurrent
    || previous.services.relayPort !== next.services.relayPort
    || previous.services.proxyPort !== next.services.proxyPort
    || previous.services.healthPort !== next.services.healthPort;
}


async function main(): Promise<void> {
  const paths = resolveBrcPaths(process.env);
  const args = process.argv.slice(2);
  const [command, ...commandArgs] = args;
  const configCommand = commandArgs[0] ?? '';
  const invalidConfig = command === 'config' && (
    (['show', 'apply', 'path'].includes(configCommand) && commandArgs.length !== 1)
    || (configCommand === 'get' && (commandArgs.length !== 2 || !isBrcSettingKey(commandArgs[1] ?? '')))
    || (configCommand === 'set' && (commandArgs.length !== 3 || !isBrcSettingKey(commandArgs[1] ?? '')))
    || !['show', 'apply', 'path', 'get', 'set'].includes(configCommand)
  );
  let invalidConfigValue = false;
  if (command === 'config' && configCommand === 'set' && commandArgs.length === 3 && isBrcSettingKey(commandArgs[1])) {
    try {
      parseSettingArgument(commandArgs[1], commandArgs[2]);
    } catch {
      invalidConfigValue = true;
    }
  }
  const simpleCommands = ['setup', 'start', 'stop', 'restart', 'status', 'clean'];
  const lightweight = command === 'help' || command === '-h' || command === '--help'
    || invalidConfig
    || invalidConfigValue
    || (command !== undefined && !['setup', 'start', 'stop', 'restart', 'status', 'logs', 'config', 'update', 'clean', 'uninstall'].includes(command))
    || (simpleCommands.includes(command ?? '') && commandArgs.length !== 0)
    || (command === 'logs' && (commandArgs.length > 1 || (commandArgs[0] && !isLogComponent(commandArgs[0]))))
    || (command === 'update' && (commandArgs.length !== 1 || commandArgs[0] !== 'traefik'))
    || (command === 'uninstall' && (commandArgs.length > 1 || (commandArgs.length === 1 && commandArgs[0] !== '--yes')));
  const clean = async (cleanPaths: BrcPaths) => {
    const { settings: cleanupSettings } = await readSettings(cleanPaths, process.env);
    const report = await cleanRuntime(cleanPaths, { settings: cleanupSettings });
    if (report.removed || report.failures.length || report.preserved.length) {
      console.log(`BRC cleanup: removed ${report.removed} items, freed ${report.bytesRemoved} bytes.`);
      for (const failure of report.failures) console.error(`BRC cleanup failed: ${failure.path}: ${failure.reason}`);
      for (const preserved of report.preserved) console.error(`BRC cleanup preserved ${preserved.path}: ${preserved.reason}`);
    }
  };
  if (lightweight) {
    process.exitCode = await runCli(args, {
      paths,
      commands: { setup: unavailable, start: unavailable, stop: unavailable, restart: unavailable, status: unavailable,
        logs: unavailable, config: (configArgs) => runConfigCommand(configArgs, { manager: undefined as unknown as SettingsManager, paths, write: (message) => console.log(message) }), updateTraefik: unavailable, uninstall: unavailable },
      clean,
      write: (message) => console.log(message),
      writeError: (message) => console.error(message),
    });
    return;
  }
  const rootWasEmpty = !existsSync(paths.root) || readdirSync(paths.root).every((entry) =>
    entry === 'runtime' && readdirSync(paths.runtime).length === 0,
  );
  const lifecycleLock = new LifecycleLock(paths);
  let configTraefikManager: TraefikManager | undefined;
  const settingsManager = await SettingsManager.load(paths, process.env, {
    lock: lifecycleLock,
    apply: async (settings, previous) => {
      if (!traefikSettingsChanged(previous, settings)) return;
      if (!configTraefikManager) throw new Error('Traefik manager is not initialized for configuration apply.');
      await configTraefikManager.writeConfigWithLockHeld(settings, previous);
    },
  });
  const settings = settingsManager.snapshot();
  lifecycleLock.updateWaitSettings({ waitMs: settings.runtime.lockWaitMs, pollMs: settings.runtime.lockPollMs });
  const processes = new ProcessManager(paths, {
    startupTimeoutMs: settings.runtime.startupTimeoutMs,
    shutdownTimeoutMs: settings.runtime.shutdownTimeoutMs,
  });
  const loadSettings = async () => {
    const current = (await readSettings(paths, process.env)).settings;
    lifecycleLock.updateWaitSettings({ waitMs: current.runtime.lockWaitMs, pollMs: current.runtime.lockPollMs });
    return current;
  };
  const refreshServices = async () => {
    const currentSettings = await loadSettings();
    processes.updateRuntimeSettings(currentSettings.runtime);
    return createDefaultServices(paths, currentSettings);
  };
  const services = createDefaultServices(paths, settings);
  const relaySpec = services.find((service) => service.name === 'relay');
  if (!relaySpec) throw new Error('The Relay service is missing from the default service set.');
  const relayDatabase = new RelayDatabase(path.join(paths.data, 'relay.sqlite'), relaySpec);
  const traefikSpec = services.find((service) => service.name === 'traefik');
  if (!traefikSpec) throw new Error('The Traefik service is missing from the default service set.');
  const serviceManager = new ServiceManager(paths, services, processes, lifecycleLock, refreshServices);
  const traefikServiceManager = new ServiceManager(paths, [traefikSpec], processes, lifecycleLock, async () => {
    const refreshed = await refreshServices();
    const current = refreshed.find((service) => service.name === 'traefik');
    if (!current) throw new Error('The Traefik service is missing from the refreshed service set.');
    return [current];
  });
  const maintenanceCommands = createMaintenanceCommands(
    paths,
    (message) => console.log(message),
    (message) => console.error(message),
    { stopServices: () => serviceManager.stop() },
  );
  const progress = new TraefikProgress(process.stderr);
  const traefikManager = new TraefikManager(paths, settings, traefikServiceManager, { loadSettings, reporter: (event) => progress.report(event) });
  configTraefikManager = traefikManager;
  const deps: CliDependencies = {
    paths,
    commands: {
      setup: async () => {
        const administrator = relayDatabase.exists() ? undefined : await requestAdministrator();
        await lifecycleLock.runExclusive(async () => {
          relayDatabase.initializeForNewRoot(rootWasEmpty, administrator);
        });
        await settingsManager.ensureConfigFile();
        await traefikManager.setup();
        console.log('BRC setup completed. Run brc start to connect services.');
        return 0;
      },
      start: async () => {
        relayDatabase.assertExists();
        await serviceManager.withLock(async (operations) => {
          const statuses = await serviceManager.status();
          const hasRunning = statuses.some((status) => status.state === 'running' || status.state === 'pairing');
          const isStaleDegraded = (status: { state: string; detail: string }) => status.state === 'degraded' && (
            status.detail.includes('Process identity changed') ||
            status.detail.includes('malformed') ||
            status.detail.includes('incomplete') ||
            status.detail.includes('belongs to another workspace') ||
            status.detail.includes('JSON') ||
            status.detail.includes('Recorded process has exited')
          );
          const hasStopped = statuses.some((status) => status.state === 'stopped' || isStaleDegraded(status));
          if (hasRunning && hasStopped) {
            throw new Error('Cannot start a partially running service set; run brc restart to apply configuration safely.');
          }
          if (statuses.every((status) => status.state === 'stopped' || isStaleDegraded(status))) {
            await traefikManager.writeConfigWithLockHeld(await loadSettings());
          }
          await operations.start();
        });
        const agent = (await serviceManager.status()).find((item) => item.name === 'agent');
        console.log(agent?.state === 'pairing'
          ? 'Relay and Traefik started. Agent awaits approval; run brc logs agent for the pairing URL and code.'
          : 'BRC services started.');
        return 0;
      },
      stop: async () => {
        await serviceManager.stop();
        console.log('BRC services stopped.');
        return 0;
      },
      restart: async () => {
        relayDatabase.assertExists();
        await serviceManager.withLock(async (operations) => {
          await operations.stop();
          await traefikManager.writeConfigWithLockHeld(await loadSettings());
          await operations.start();
        });
        console.log('BRC services restarted.');
        return 0;
      },
      status: async () => {
        const statuses = await serviceManager.status();
        for (const status of statuses) {
          const pid = status.pid === null ? '' : ` PID ${status.pid}`;
          console.log(`${status.name}: ${status.state}${pid} — ${status.detail}`);
        }
        return statuses.some((status) => status.state === 'degraded') ? 1 : 0;
      },
      logs: maintenanceCommands.logs,
      config: async (args) => runConfigCommand(args, {
        manager: settingsManager,
        paths,
        write: (message) => console.log(message),
      }),
      updateTraefik: async () => {
        const previous = await traefikManager.currentVersion();
        await traefikManager.update();
        const current = await traefikManager.currentVersion();
        if (!current) throw new Error('Traefik update completed without an installed version.');
        console.log(current === previous ? `Traefik ${current} is current.` : `Traefik updated: ${previous ?? 'not installed'} → ${current}.`);
        return 0;
      },
      uninstall: maintenanceCommands.uninstall,
    },
    clean,
    write: (message) => console.log(message),
    writeError: (message) => console.error(message),
  };
  const removeInterruptHandler = installProgressInterruptHandler(progress);
  try {
    process.exitCode = await runCli(process.argv.slice(2), deps);
  } finally {
    progress.stop();
    removeInterruptHandler();
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  if (process.env.BRC_MANAGED_SERVICE === 'traefik' && process.argv.includes('--run-traefik')) {
    const paths = resolveBrcPaths(process.env);
    const { settings } = await readSettings(paths, process.env);
    await runManagedTraefikService(settings);
  } else {
    await main();
  }
}
