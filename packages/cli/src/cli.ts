#!/usr/bin/env node
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendTraceSummary, startDiagnostics, TraceRecorder, type DiagnosticsRuntime, type TraceSummary } from 'brc-shared';
import { readProductVersion } from './config/product.js';
import { runFunctionDiagnostics, runResourceDiagnostics, runStartupDiagnostics } from './commands/diagnostics.js';
import { helpText, parseCommand, UsageError, type CliCommandName, type ParsedCommand } from './commands/parser.js';
import { installCancellationHandlers } from './commands/signals.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConfigCommand } from './commands/config.js';
import { requestAdministrator } from './commands/setup.js';
import { resolveBrcPaths, type BrcPaths } from './config/paths.js';
import { SettingsManager } from './config/manager.js';
import { readSettings } from './config/reader.js';
import type { BrcSettings } from './config/settings.js';
import { LifecycleLock } from './adapters/storage/lock.js';
import { ProcessManager } from './adapters/process/controller.js';
import { ServiceManager } from './core/lifecycle/workflow.js';
import { createDefaultServices, diagnosticEnvironment } from './adapters/process/specs.js';
import { startRejection, shouldWriteTraefikConfig } from './core/lifecycle/policy.js';
import { cleanRuntime } from './adapters/storage/cleanup.js';
import { createMaintenanceCommands } from './commands/maintenance.js';
import { TraefikManager } from './traefik/manager.js';
import { runManagedTraefikService } from './traefik/runtime.js';
import { RelayDatabase } from './adapters/storage/relay-database.js';
import { installProgressInterruptHandler, TraefikProgress } from './progress.js';

export type CliLogComponent = 'relay' | 'agent' | 'traefik' | 'cli';
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
    config: (args: string[], options: { json: boolean }) => Promise<CommandResult>;
    updateTraefik: () => Promise<CommandResult>;
    uninstall: (options: { yes: boolean }, clean: () => Promise<void>) => Promise<CommandResult>;
  };
  clean: (paths: BrcPaths) => Promise<void>;
  write: (message: string) => void;
  writeError: (message: string) => void;
  statusJson?: () => Promise<unknown>;
  trace?: TraceRecorder;
  onTrace?: (summary: TraceSummary) => Promise<void>;
  timing?: boolean;
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

async function dispatch(
  parsed: ParsedCommand,
  deps: CliDependencies,
  clean: () => Promise<void>,
  skipAutomaticCleanup: () => void,
): Promise<number> {
  switch (parsed.name) {
    case 'help': {
      if (parsed.includeStatus) {
        try {
          await deps.commands.status();
        } catch (error) {
          deps.writeError(`brc: ${errorMessage(error)}`);
        }
      }
      deps.write(parsed.args[0] ? helpText(parsed.args[0] as CliCommandName) : helpText());
      return 0;
    }
    case 'version':
      deps.write(parsed.json ? JSON.stringify({ version: readProductVersion() }) : readProductVersion());
      return 0;
    case 'diagnose':
      if (parsed.diagnose === 'functions') return runFunctionDiagnostics(deps.paths, parsed.json, deps.write);
      if (parsed.diagnose === 'resources') return runResourceDiagnostics(deps.paths, parsed.json, deps.write);
      return runStartupDiagnostics(deps.paths, parsed.json, deps.write);
    case 'setup':
      return (await deps.commands.setup()) ?? 0;
    case 'start':
      return (await deps.commands.start()) ?? 0;
    case 'stop':
      return (await deps.commands.stop()) ?? 0;
    case 'restart':
      return (await deps.commands.restart()) ?? 0;
    case 'status':
      if (parsed.json) {
        if (!deps.statusJson) throw new UsageError('JSON status is unavailable.');
        deps.write(JSON.stringify(await deps.statusJson()));
        return 0;
      }
      return (await deps.commands.status()) ?? 0;
    case 'logs':
      return (await deps.commands.logs(parsed.logComponent)) ?? 0;
    case 'config':
      return (await deps.commands.config(parsed.args, { json: parsed.json })) ?? 0;
    case 'update':
      return (await deps.commands.updateTraefik()) ?? 0;
    case 'clean':
      skipAutomaticCleanup();
      await clean();
      return 0;
    case 'uninstall':
      skipAutomaticCleanup();
      return (await deps.commands.uninstall({ yes: parsed.args[0] === '--yes' }, clean)) ?? 0;
    default:
      throw new UsageError(`Unknown command: ${parsed.name}. Run brc help for usage.`);
  }
}

function reportTrace(deps: CliDependencies, summary: TraceSummary): void {
  if (!deps.timing) return;
  deps.writeError(`Startup total: ${summary.durationMs.toFixed(1)} ms; unassigned: ${summary.unaccountedMs.toFixed(1)} ms`);
  for (const stage of summary.stages) {
    deps.writeError(`  ${stage.stage}${stage.service ? ' / ' + stage.service : ''}: ${stage.durationMs.toFixed(1)} ms (${stage.status})`);
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
    const parsed = parseCommand(args);
    const invoke = () => dispatch(parsed, deps, clean, () => { skipCleanup = true; });
    exitCode = deps.trace ? await deps.trace.span('command', invoke) : await invoke();
  } catch (error) {
    deps.writeError(`brc: ${errorMessage(error)}`);
    exitCode = errorExitCode(error);
  } finally {
    if (!skipCleanup) {
      try {
        if (deps.trace) await deps.trace.span('automatic-cleanup', clean);
        else await clean();
      } catch (error) {
        deps.writeError(`brc: cleanup failed: ${errorMessage(error)}`);
      }
    }
    if (deps.trace) {
      const summary = deps.trace.finish(exitCode === 0 ? 'ok' : 'failed', exitCode === 0 ? undefined : 'COMMAND_FAILED');
      try { await deps.onTrace?.(summary); }
      catch (error) { deps.writeError(`brc: diagnostic write failed: ${errorMessage(error)}`); }
      reportTrace(deps, summary);
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
  let parsed: ParsedCommand | undefined;
  try { parsed = parseCommand(args); } catch { /* reported by runCli */ }
  const trace = parsed?.name === 'start' ? new TraceRecorder('start', randomUUID()) : undefined;
  const time = <T>(stage: string, task: () => Promise<T>): Promise<T> => (trace ? trace.span(stage, task) : task());
  const lightweight = !parsed || parsed.name === 'help' || parsed.name === 'version' || parsed.name === 'diagnose';
  const clean = async (cleanPaths: BrcPaths) => {
    const { settings: cleanupSettings } = await readSettings(cleanPaths, process.env);
    const report = await cleanRuntime(cleanPaths, { settings: cleanupSettings });
    if (report.removed || report.failures.length || report.preserved.length) {
      console.error(`BRC cleanup: removed ${report.removed} items, freed ${report.bytesRemoved} bytes.`);
      for (const failure of report.failures) console.error(`BRC cleanup failed: ${failure.path}: ${failure.reason}`);
      for (const preserved of report.preserved) console.error(`BRC cleanup preserved ${preserved.path}: ${preserved.reason}`);
    }
  };
  if (lightweight) {
    process.exitCode = await runCli(args, {
      paths,
      commands: { setup: unavailable, start: unavailable, stop: unavailable, restart: unavailable, status: unavailable,
        logs: unavailable, config: (configArgs, options) => runConfigCommand(configArgs, { manager: undefined as unknown as SettingsManager, paths, write: (message) => console.log(message), json: options.json }), updateTraefik: unavailable, uninstall: unavailable },
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
  const diagnostics = await startDiagnostics({
    component: 'cli',
    instanceId: `cli-${process.pid}`,
    env: { ...process.env, ...diagnosticEnvironment(settings, paths) },
    manifestUrl: new URL('./diagnostics-manifest.json', import.meta.url),
    logFile: path.join(paths.logs, 'cli-diagnostics.log'),
  });
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
  const serviceManager = new ServiceManager(paths, services, processes, lifecycleLock, refreshServices, trace);
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
        await time('database-check', async () => relayDatabase.assertExists());
        const lockSpan = trace?.begin('lifecycle-lock');
        try {
          await serviceManager.withLock(async (operations) => {
            lockSpan?.end();
            const statuses = await time('initial-status', () => serviceManager.status());
            const rejection = startRejection(statuses);
            if (rejection) throw new Error(rejection);
            if (shouldWriteTraefikConfig(statuses)) {
              await time('traefik-config', async () => traefikManager.writeConfigWithLockHeld(await loadSettings()));
            }
            await time('services-ready', () => operations.start(statuses));
          });
        } catch (error) {
          lockSpan?.end('failed');
          throw error;
        }
        const agent = (await time('post-start-status', () => serviceManager.status()))
          .find((item) => item.name === 'agent');
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
      config: async (configArgs, options) => runConfigCommand(configArgs, {
        manager: settingsManager,
        paths,
        write: (message) => console.log(message),
        json: options.json,
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
    statusJson: async () => ({ services: await serviceManager.status() }),
    trace,
    timing: args.includes('--timing'),
    onTrace: async (summary) => appendTraceSummary(path.join(paths.logs, 'cli.log'), summary, {
      maxBytes: settings.logs.rotateMiB * 1024 * 1024,
    }),
  };
  const removeInterruptHandler = installProgressInterruptHandler(progress);
  const removeCancellation = installCancellationHandlers({
    flush: async () => {
      progress.stop();
      if (trace) {
        const summary = trace.finish('cancelled', 'INTERRUPTED');
        try { await appendTraceSummary(path.join(paths.logs, 'cli.log'), summary, {
          maxBytes: settings.logs.rotateMiB * 1024 * 1024,
        }); } catch { /* diagnostics must not block exit */ }
      }
      await diagnostics.stop();
    },
    exit: (code) => { process.exitCode = code; process.exit(code); },
  });
  try {
    process.exitCode = await runCli(process.argv.slice(2), deps);
  } finally {
    progress.stop();
    removeInterruptHandler();
    removeCancellation();
    await diagnostics.stop();
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
    const diagnostics = await startDiagnostics({
      component: 'traefik',
      instanceId: `traefik-${process.pid}`,
      env: { ...process.env, ...diagnosticEnvironment(settings, paths) },
      manifestUrl: new URL('./diagnostics-manifest.json', import.meta.url),
      logFile: path.join(paths.logs, 'traefik-diagnostics.log'),
    });
    try {
      await runManagedTraefikService(settings, diagnostics);
    } finally {
      await diagnostics.stop();
    }
  } else {
    await main();
  }
}
