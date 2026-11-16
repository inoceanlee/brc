#!/usr/bin/env node
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appendTraceSummary, startDiagnostics, TraceRecorder, FileSnapshotStore, cliSuccess, cliFailure, renderCliResult, type CliExitCode, type CliResult, type TraceSummary } from 'brc-shared';
import { readProductVersion } from './config/product.js';
import { readFunctionDiagnostics, readLatestLifecycle, readLatestStartup, readResourceDiagnostics } from './commands/diagnostics.js';
import { COMMAND_SPECS, helpText, parseCommand, UsageError, type CliCommandName, type ParsedCommand } from './commands/parser.js';
import { installCancellationHandlers, SIGNAL_EXIT_CODES } from './commands/signals.js';
import { completionScript } from './commands/completion.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runConfigCommand } from './commands/config.js';
import { requestAdministrator } from './commands/setup.js';
import { resolveBrcPaths, type BrcPaths } from './config/paths.js';
import { SettingsManager } from './config/manager.js';
import { readSettings } from './config/reader.js';
import type { BrcSettings } from './config/settings.js';
import { LifecycleLock } from './adapters/storage/lock.js';
import { ProcessManager } from './adapters/process/controller.js';
import { inspectProcess } from './adapters/process/identity.js';
import { ManagedProcessResourceSampler } from './adapters/process/resources.js';
import { ServiceManager } from './core/lifecycle/workflow.js';
import { createDefaultServices, diagnosticEnvironment } from './adapters/process/specs.js';
import { startRejection, shouldWriteTraefikConfig } from './core/lifecycle/policy.js';
import { cleanRuntime } from './adapters/storage/cleanup.js';
import { createMaintenanceCommands } from './commands/maintenance.js';
import { confirmBrcUninstall } from './maintenance/uninstall.js';
import { readManagedLog } from './maintenance/logs.js';
import { TraefikManager } from './traefik/manager.js';
import { runManagedTraefikService } from './traefik/runtime.js';
import { RelayDatabase } from './adapters/storage/relay-database.js';
import { TraefikProgress } from './progress.js';

export type CliLogComponent = 'relay' | 'agent' | 'traefik' | 'cli';
type CommandResult = number | void | CliResult;

export interface CliDependencies {
  paths: BrcPaths;
  commands: {
    setup: (signal?: AbortSignal) => Promise<CommandResult>;
    start: (signal?: AbortSignal) => Promise<CommandResult>;
    stop: (signal?: AbortSignal) => Promise<CommandResult>;
    restart: (signal?: AbortSignal) => Promise<CommandResult>;
    status: () => Promise<CommandResult>;
    logs: (component?: CliLogComponent) => Promise<CommandResult>;
    config: (args: string[], options: { json: boolean; preview?: boolean; signal?: AbortSignal }) => Promise<CommandResult>;
    updateTraefik: (signal?: AbortSignal) => Promise<CommandResult>;
    uninstall: (options: { yes: boolean; structuredOutput?: boolean; signal?: AbortSignal }, clean: () => Promise<void>) => Promise<CommandResult>;
  };
  clean: (paths: BrcPaths) => Promise<void>;
  write: (message: string) => void;
  writeError: (message: string) => void;
  statusJson?: () => Promise<unknown>;
  trace?: TraceRecorder;
  onTrace?: (summary: TraceSummary) => Promise<void>;
  timing?: boolean;
  signal?: AbortSignal;
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

const yaml = createRequire(import.meta.url)('js-yaml') as { safeDump(value: unknown): string };

function renderOutput(result: CliResult, parsed: ParsedCommand, deps: CliDependencies): number {
  return renderCliResult(result, {
    format: parsed.output,
    quiet: parsed.quiet,
    verbose: parsed.verbose,
    stringifyYaml: (value) => yaml.safeDump(value),
  }, {
    stdout: (value) => deps.write(value.trimEnd()),
    stderr: (value) => deps.writeError(value.trimEnd()),
  });
}

function completeCommand(result: CommandResult, parsed: ParsedCommand, deps: CliDependencies): number {
  if (result && typeof result === 'object') return renderOutput(result, parsed, deps);
  if (typeof result === 'number' && result !== 0) return result;
  if (parsed.output !== 'table') {
    return renderOutput(cliSuccess({ command: parsed.name, status: 'success' }), parsed, deps);
  }
  return 0;
}

function renderFailure(error: unknown, parsed: ParsedCommand | undefined, format: ParsedCommand['output'], deps: CliDependencies): number {
  const exitCode = errorExitCode(error);
  if (exitCode === 130 || exitCode === 143) return exitCode;
  const code = exitCode === 2 ? 'USAGE_ERROR' : exitCode === 3 ? 'PERMISSION_DENIED'
    : exitCode === 4 ? 'NOT_FOUND' : exitCode === 5 ? 'CONFLICT' : 'RUNTIME_ERROR';
  const details = parsed?.debug || parsed?.verbose
    ? error instanceof Error ? { name: error.name, stack: error.stack } : undefined
    : undefined;
  const failure = cliFailure({
    code,
    exitCode: exitCode as Exclude<CliExitCode, 0>,
    message: errorMessage(error),
    run: 'brc help',
    retryable: exitCode === 1,
    ...(details ? { details } : {}),
  });
  return renderCliResult(failure, { format, verbose: parsed?.verbose, quiet: parsed?.quiet }, {
    stdout: deps.write,
    stderr: (value) => deps.writeError(value.trimEnd()),
  });
}

async function dispatch(
  parsed: ParsedCommand,
  deps: CliDependencies,
  clean: () => Promise<void>,
  skipAutomaticCleanup: () => void,
): Promise<number> {
  if (parsed.preview && ['setup', 'start', 'stop', 'restart', 'uninstall', 'clean'].includes(parsed.name)) {
    throw new UsageError(`--preview is unsupported for brc ${parsed.name}; no changes were made.`);
  }
  if (parsed.offline && parsed.name === 'update') {
    throw new UsageError('Traefik update requires release metadata; --offline prevents remote queries.');
  }
  switch (parsed.name) {
    case 'help':
      return renderOutput(cliSuccess(parsed.output === 'json'
        ? { commands: COMMAND_SPECS, version: readProductVersion() }
        : helpText(parsed.args[0] as CliCommandName | undefined)), parsed, deps);
    case 'version':
      return renderOutput(cliSuccess(parsed.output === 'json'
        ? { version: readProductVersion() } : readProductVersion()), parsed, deps);
    case 'completion':
      return renderOutput(cliSuccess(completionScript(parsed.args[0] as 'powershell' | 'bash' | 'zsh' | 'fish')), parsed, deps);
    case 'diagnose': {
      if (parsed.diagnose === 'functions') {
        const rows = await readFunctionDiagnostics(deps.paths);
        return renderOutput(cliSuccess(rows.length ? rows : [{ message: 'No function statistics are available. Start a managed service with diagnostics enabled.' }]), parsed, deps);
      }
      if (parsed.diagnose === 'resources') {
        const rows = await readResourceDiagnostics(deps.paths);
        return renderOutput(cliSuccess(rows.length ? rows : [{ message: 'No resource samples are available. Start a managed service with diagnostics enabled.' }]), parsed, deps);
      }
      const result = parsed.diagnose === 'lifecycle'
        ? await readLatestLifecycle(deps.paths)
        : await readLatestStartup(deps.paths);
      return renderOutput(cliSuccess(result.summary ? result : {
        ...result,
        message: parsed.diagnose === 'lifecycle'
          ? 'No lifecycle diagnosis has been recorded.'
          : 'No startup diagnosis has been recorded.',
      }), parsed, deps);
    }
    case 'setup':
      return completeCommand(await deps.commands.setup(deps.signal), parsed, deps);
    case 'start':
      return completeCommand(await deps.commands.start(deps.signal), parsed, deps);
    case 'stop':
      return completeCommand(await deps.commands.stop(deps.signal), parsed, deps);
    case 'restart':
      return completeCommand(await deps.commands.restart(deps.signal), parsed, deps);
    case 'status':
      if (parsed.output !== 'table' && deps.statusJson) {
        return renderOutput(cliSuccess(await deps.statusJson()), parsed, deps);
      }
      return completeCommand(await deps.commands.status(), parsed, deps);
    case 'logs':
      if (parsed.output !== 'table') {
        const component = parsed.logComponent ?? 'cli';
        const contents = await readManagedLog(deps.paths, component);
        return renderOutput(cliSuccess({ component, lines: contents ? contents.trimEnd().split(/\r?\n/) : [] }), parsed, deps);
      }
      return completeCommand(await deps.commands.logs(parsed.logComponent), parsed, deps);
    case 'config':
      return completeCommand(await deps.commands.config(parsed.args, { json: parsed.json, preview: parsed.preview, signal: deps.signal }), parsed, deps);
    case 'update':
      return completeCommand(await deps.commands.updateTraefik(deps.signal), parsed, deps);
    case 'clean':
      skipAutomaticCleanup();
      await clean();
      return renderOutput(cliSuccess({ command: 'clean', status: 'success' }), parsed, deps);
    case 'uninstall':
      skipAutomaticCleanup();
      return completeCommand(await deps.commands.uninstall({
        yes: parsed.args[0] === '--yes',
        structuredOutput: parsed.output !== 'table',
        signal: deps.signal,
      }, clean), parsed, deps);
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

  let parsed: ParsedCommand | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timeoutController: AbortController | undefined;
  try {
    parsed = parseCommand(args);
    if (parsed.timeoutMs !== undefined) {
      timeoutController = new AbortController();
      timeoutHandle = setTimeout(() => {
        const error = Object.assign(new Error(`Command timed out after ${parsed!.timeoutMs} ms.`), { exitCode: 1 });
        timeoutController?.abort(error);
      }, parsed.timeoutMs);

    }
    const signal = deps.signal && timeoutController
      ? AbortSignal.any([deps.signal, timeoutController.signal])
      : deps.signal ?? timeoutController?.signal;
    signal?.throwIfAborted();
    const commandDeps = signal ? { ...deps, signal } : deps;
    const invoke = () => dispatch(parsed!, commandDeps, clean, () => { skipCleanup = true; });
    exitCode = deps.trace ? await deps.trace.span('command', invoke) : await invoke();
  } catch (error) {
    const requestedJson = args.includes('--json') || args.includes('--output=json')
      || args.some((value, index) => (value === '--output' || value === '-o') && args[index + 1] === 'json');
    exitCode = renderFailure(error, parsed, parsed?.output ?? (requestedJson ? 'json' : 'table'), deps);
  } finally {
    if (!skipCleanup) {
      try {
        if (deps.trace) await deps.trace.span('automatic-cleanup', clean);
        else await clean();
      } catch (error) {
        deps.writeError(`brc: cleanup failed: ${errorMessage(error)}`);
      }
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (deps.trace) {
      const traceStatus = exitCode === 130 || exitCode === 143 ? 'cancelled' : exitCode === 0 ? 'ok' : 'failed';
      const summary = deps.trace.finish(traceStatus, exitCode === 0 ? undefined : exitCode === 130 || exitCode === 143 ? 'INTERRUPTED' : 'COMMAND_FAILED');
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
  const lifecycleCommand = parsed && ['start', 'stop', 'restart'].includes(parsed.name) ? parsed.name : undefined;
  const trace = lifecycleCommand ? new TraceRecorder(lifecycleCommand, randomUUID()) : undefined;
  const time = <T>(stage: string, task: () => Promise<T>): Promise<T> => (trace ? trace.span(stage, task) : task());
  const lightweight = !parsed || parsed.name === 'help' || parsed.name === 'version' || parsed.name === 'diagnose' || parsed.name === 'completion';
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
        logs: unavailable, config: (configArgs, options) => runConfigCommand(configArgs, { manager: undefined as unknown as SettingsManager, paths, preview: options.preview, signal: options.signal }), updateTraefik: unavailable, uninstall: unavailable },
      clean,
      write: (message) => console.log(message),
      writeError: (message) => console.error(message),
    });
    return;
  }
  const rootWasEmpty = !existsSync(paths.root) || readdirSync(paths.root).every((entry) =>
    entry === 'runtime' && readdirSync(paths.runtime).length === 0,
  );
  const serviceParentEnv = parsed?.noTelemetry ? { ...process.env, DO_NOT_TRACK: '1' } : process.env;
  const lifecycleLock = new LifecycleLock(paths);
  let configTraefikManager: TraefikManager | undefined;
  const settingsManager = await SettingsManager.load(paths, process.env, {
    lock: lifecycleLock,
    readOnly: parsed?.preview === true,
    apply: async (settings, previous, signal) => {
      if (!traefikSettingsChanged(previous, settings)) return;
      if (!configTraefikManager) throw new Error('Traefik manager is not initialized for configuration apply.');
      await configTraefikManager.writeConfigWithLockHeld(settings, previous, signal);
    },
  });
  const settings = settingsManager.snapshot();
  lifecycleLock.updateWaitSettings({ waitMs: settings.runtime.lockWaitMs, pollMs: settings.runtime.lockPollMs });
  const diagnosticEnv = { ...process.env, ...diagnosticEnvironment(settings, paths) };
  if (parsed?.name === 'uninstall') diagnosticEnv.BRC_DIAGNOSTICS_ENABLED = 'false';
  const diagnostics = await startDiagnostics({
    component: 'cli',
    instanceId: String(process.pid),
    env: diagnosticEnv,
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
    return createDefaultServices(paths, currentSettings, serviceParentEnv);
  };
  const services = createDefaultServices(paths, settings, serviceParentEnv);
  const relaySpec = services.find((service) => service.name === 'relay');
  if (!relaySpec) throw new Error('The Relay service is missing from the default service set.');
  const relayDatabase = new RelayDatabase(path.join(paths.data, 'relay.sqlite'), relaySpec);
  const traefikSpec = services.find((service) => service.name === 'traefik');
  if (!traefikSpec) throw new Error('The Traefik service is missing from the default service set.');
  const serviceManager = new ServiceManager(paths, services, processes, processes, lifecycleLock, refreshServices, trace);
  const traefikServiceManager = new ServiceManager(paths, [traefikSpec], processes, processes, lifecycleLock, async () => {
    const refreshed = await refreshServices();
    const current = refreshed.find((service) => service.name === 'traefik');
    if (!current) throw new Error('The Traefik service is missing from the refreshed service set.');
    return [current];
  });
  const maintenanceCommands = createMaintenanceCommands(
    paths,
    (message) => console.log(message),
    (message) => console.error(message),
    {
      stopServices: (signal) => serviceManager.stop(signal),
      confirm: (root) => confirmBrcUninstall(root, { interactive: parsed?.interactive, noInput: parsed?.noInput }),
    },
  );
  const commandController = new AbortController();
  const progress = new TraefikProgress(process.stderr, {
    color: parsed?.noColor !== true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
    enabled: parsed?.quiet !== true,
  });
  const traefikManager = new TraefikManager(paths, settings, traefikServiceManager, { loadSettings, reporter: (event) => progress.report(event) });
  configTraefikManager = traefikManager;
  const deps: CliDependencies = {
    paths,
    commands: {
      setup: async (signal) => {
        signal?.throwIfAborted();
        if (parsed?.offline && !await traefikManager.currentVersion()) {
          throw new UsageError('Traefik is not installed and --offline prevents its download.');
        }
        const administrator = relayDatabase.exists() ? undefined : await requestAdministrator({ interactive: parsed?.interactive, noInput: parsed?.noInput, signal });
        await lifecycleLock.runExclusive(async () => {
          signal?.throwIfAborted();
          relayDatabase.initializeForNewRoot(rootWasEmpty, administrator);
        }, signal);
        await settingsManager.ensureConfigFile(signal);
        await traefikManager.setup(signal);
        if (parsed?.output === 'table') console.log('BRC setup completed. Run brc start to connect services.');
        return 0;
      },
      start: async (signal) => {
        signal?.throwIfAborted();
        await time('database-check', async () => relayDatabase.assertExists());
        const lockSpan = trace?.begin('lifecycle-lock');
        try {
          await serviceManager.withLock(async (operations) => {
            signal?.throwIfAborted();
            lockSpan?.end();
            const statuses = await time('initial-status', () => serviceManager.status());
            const rejection = startRejection(statuses);
            if (rejection) throw new Error(rejection);
            if (shouldWriteTraefikConfig(statuses)) {
              await time('traefik-config', async () => traefikManager.writeConfigWithLockHeld(await loadSettings(), undefined, signal));
            }
            await time('services-ready', () => operations.start(statuses, signal));
          }, signal);
        } catch (error) {
          lockSpan?.end('failed');
          throw error;
        }
        const agent = (await time('post-start-status', () => serviceManager.status()))
          .find((item) => item.name === 'agent');
        if (parsed?.output === 'table') console.log(agent?.state === 'pairing'
          ? 'Relay and Traefik started. Agent awaits approval; run brc logs agent for the pairing URL and code.'
          : 'BRC services started.');
        return 0;
      },
      stop: async (signal) => {
        await time('services-stop', () => serviceManager.stop(signal));
        if (parsed?.output === 'table') console.log('BRC services stopped.');
        return 0;
      },
      restart: async (signal) => {
        signal?.throwIfAborted();
        await time('database-check', async () => relayDatabase.assertExists());
        await time('lifecycle-lock', () => serviceManager.withLock(async (operations) => {
          signal?.throwIfAborted();
          await time('restart-stop', () => operations.stop());
          try {
            signal?.throwIfAborted();
            await time('restart-config', async () => traefikManager.writeConfigWithLockHeld(await loadSettings(), undefined, signal));
            await time('restart-start', () => operations.start(undefined, signal));
          } catch (error) {
            if (signal?.aborted) await time('restart-recovery-start', () => operations.start());
            throw error;
          }
        }, signal));
        if (parsed?.output === 'table') console.log('BRC services restarted.');
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
        preview: options.preview,
        signal: options.signal,
      }),
      updateTraefik: async (signal) => {
        if (parsed?.offline) throw new UsageError('--offline prevents Traefik release lookup and download.');
        if (parsed?.preview) {
          const preview = await traefikManager.previewUpdate(signal);
          return cliSuccess({ command: 'update', component: 'traefik', preview: true, ...preview });
        }
        const previous = await traefikManager.currentVersion();
        await traefikManager.update(signal);
        const current = await traefikManager.currentVersion();
        if (!current) throw new Error('Traefik update completed without an installed version.');
        if (parsed?.output === 'table') console.log(current === previous ? `Traefik ${current} is current.` : `Traefik updated: ${previous ?? 'not installed'} → ${current}.`);
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
    signal: commandController.signal,
  };
  let commandPromise: Promise<number> | undefined;
  const removeCancellation = installCancellationHandlers({
    abort: (signal) => {
      const error = Object.assign(new Error(`Received ${signal}.`), { exitCode: SIGNAL_EXIT_CODES[signal] });
      commandController.abort(error);
    },
    flush: async () => {
      progress.stop();
      await commandPromise?.catch(() => undefined);
      await diagnostics.stop();
    },
    exit: (code) => { process.exitCode = code; process.exit(code); },
  });
  try {
    commandPromise = runCli(process.argv.slice(2), deps);
    process.exitCode = await commandPromise;
  } finally {
    progress.stop();
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
      instanceId: process.env.BRC_MANAGED_ID ?? String(process.pid),
      env: { ...process.env, ...diagnosticEnvironment(settings, paths) },
      manifestUrl: new URL('./diagnostics-manifest.json', import.meta.url),
      logFile: path.join(paths.logs, 'traefik-diagnostics.log'),
    });
    try {
      const snapshots = settings.diagnostics.enabled ? new FileSnapshotStore({ directory: paths.diagnostics }) : undefined;
      const createBinaryResourceMonitor = snapshots ? async (pid: number, instanceId: string) => {
        const identity = await inspectProcess(pid);
        if (!identity) throw new Error('Traefik binary process identity could not be verified for resource sampling.');
        return new ManagedProcessResourceSampler({
          identity,
          instanceId,
          runtimeDirectory: paths.runtime,
          intervalMs: settings.diagnostics.resourceSampleMs,
          snapshots,
          onError: (error) => diagnostics.log('Traefik binary resource sample failed.', {
            level: 'warn',
            error,
            source: { file: 'adapters/process/resources.ts', function: 'ManagedProcessResourceSampler' },
          }),
        });
      } : undefined;
      await runManagedTraefikService(settings, diagnostics, { createBinaryResourceMonitor });
    } finally {
      await diagnostics.stop();
    }
  } else {
    await main();
  }
}
