#!/usr/bin/env node
import { createRequire } from 'node:module';
import { cliFailure, cliSuccess, renderCliResult, createDiagnosticsRuntime, DiagnosticSession, FileDiagnosticLog, FileSnapshotStore, FunctionTiming, installFunctionProbe, NodeResourceSampler, type CliResult } from 'brc-shared';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import type { AgentConnectionServices } from './adapters/transport/connection.js';
import { parseAgentInvocation } from './commands/parser.js';
import { runAgentLocalCommand } from './commands/local.js';
import { toCliError } from './commands/errors.js';
import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRC_SETTING_KEYS, FileSettingsLock, YamlSettingsStore } from 'brc-shared';
import { ConfigStorage } from './adapters/storage/config-storage.js';
import { resolveAgentPaths } from './adapters/storage/agent-paths.js';
import { CredentialStore } from './adapters/storage/credential-store.js';
import { migrateCredentialFile } from './adapters/storage/credential-migration.js';
import type { WsClientOptions } from './adapters/transport/ws-client.js';
import { VERSION } from './core/version.js';
import { ToolHistoryStorage } from './adapters/telemetry/toolHistoryStorage.js';
import { AgentConfigManager, resolveAgentSettings } from './adapters/storage/config-manager.js';
import { FeatureFlagManager } from './adapters/network/feature-flags.js';
import { SearchManager } from './adapters/system/search-manager.js';
import { CommandManager } from './adapters/terminal/command-manager.js';
import { TerminalManager } from './adapters/terminal/terminal-manager.js';
import { ToolHistory } from './adapters/telemetry/toolHistory.js';
import { UsageTracker } from './adapters/telemetry/usageTracker.js';
import { FileHandlerFactory, TextFileHandler, ImageFileHandler, BinaryFileHandler, ExcelFileHandler } from './adapters/filesystem/files/index.js';
import { PdfFileHandler } from './adapters/filesystem/files/pdf.js';
import { DocxFileHandler } from './adapters/filesystem/files/docx.js';
import { FuzzySearchLogger } from './adapters/telemetry/fuzzySearchLogger.js';
import { trackToolCall } from './adapters/telemetry/trackTools.js';
import { createCapture } from './adapters/telemetry/capture.js';
import { getSystemInfo } from './adapters/system/system-info.js';
import { createAgentLogger } from './adapters/telemetry/logger.js';
import { WsClient } from './adapters/transport/ws-client.js';
import { createToolDispatcher } from './adapters/mcp/dispatcher.js';
import { AgentContext } from './context.js';

import type { AgentCredentials, AgentServices } from './composition.js';

export function createAgentCredentials(env: NodeJS.ProcessEnv): AgentCredentials {
  const paths = resolveAgentPaths(env);
  const credentialStore = new CredentialStore(path.dirname(paths.credentialsFile));
  const legacyStore = new CredentialStore(paths.legacyDirectory);
  return {
    filename: paths.credentialsFile,
    load: () => {
      migrateCredentialFile(path.join(paths.legacyDirectory, 'device.json'), path.dirname(paths.credentialsFile), legacyStore, credentialStore);
      return credentialStore.load();
    },
    save: (value) => credentialStore.save(value),
    exists: () => existsSync(paths.credentialsFile),
    clear: () => {
      if (!existsSync(paths.credentialsFile)) return false;
      unlinkSync(paths.credentialsFile);
      return true;
    },
  };
}

export async function configureAgentServices(): Promise<AgentServices> {
  const env = { ...process.env };
  const paths = resolveAgentPaths(env);
  const logger = createAgentLogger();
  const credentials = createAgentCredentials(env);
  const yaml = createRequire(import.meta.url)('js-yaml') as {
    safeLoad(data: string): unknown;
    safeDump(data: unknown, options: { noRefs: boolean }): string;
  };
  const settingsStore = new YamlSettingsStore({
    filename: paths.configFile,
    codec: { parse: (data) => yaml.safeLoad(data), stringify: (data) => yaml.safeDump(data, { noRefs: true }) },
    lock: new FileSettingsLock(path.dirname(paths.configFile)),
    backupFilename: paths.configFile + '.last-good',
    backupKeys: BRC_SETTING_KEYS.filter((key) => key.startsWith('agent.')),
  });
  const configManager = new AgentConfigManager(
    settingsStore,
    new ConfigStorage(path.join(paths.historyDirectory, 'state.json')),
    new ConfigStorage(paths.usageFile),
    { paths, env },
  );
  const featureFlagManager = new FeatureFlagManager(paths.featureFlagFile, logger, env);
  const currentClient = { name: 'brc-agent', version: VERSION };
  const context = new AgentContext(currentClient);
  const { capture } = createCapture({
    env,
    configManager,
    getContext: () => context.current(),
    getSystemInfo,
  });
  const fileHandlers = new FileHandlerFactory(
    new DocxFileHandler(), new PdfFileHandler(), new ExcelFileHandler(),
    new ImageFileHandler(), new BinaryFileHandler(), new TextFileHandler(),
  );
  const createClient = (options: WsClientOptions) => new WsClient(options);
  const filesystem = { configManager, capture, fileHandlers };
  const transfer = { ...filesystem, receiveKeys: new Map() };
  const commandManager = new CommandManager(configManager, capture);
  const terminalManager = new TerminalManager(configManager, capture);
  const terminal = { configManager, commandManager, terminalManager, capture };
  const searchManager = new SearchManager(filesystem);
  let historyFailureReporter: (message: string) => void = (message) => process.stderr.write(message + '\n');
  const reportHistoryFailure = () => historyFailureReporter('Failed to persist tool history.');
  const bindHistoryFailureReporter = (report: (message: string) => void) => {
    historyFailureReporter = report;
    return () => { historyFailureReporter = (message) => process.stderr.write(message + '\n'); };
  };
  const toolHistory = new ToolHistory(new ToolHistoryStorage(paths.historyDirectory), reportHistoryFailure);
  const usageTracker = new UsageTracker({
    configManager, featureFlagManager, getCurrentClient: () => currentClient,
    isOnboardingDisabled: () => 'disableOnboarding' in globalThis && Boolean(globalThis.disableOnboarding),
    logger,
  });
  const logMaxBytes = async () => (
    resolveAgentSettings((await settingsStore.read()).settings, env).logs.rotateMiB * 1024 * 1024
  );
  const fuzzySearchLogger = new FuzzySearchLogger(paths.logsDirectory, logMaxBytes);
  const dispatcher = createToolDispatcher({
    configManager, featureFlagManager, searchManager, toolHistory, usageTracker, fuzzySearchLogger,
    filesystem, terminal, transfer, currentClient,
    logHistoryFailure: reportHistoryFailure,
    trackToolCall: async (name) => trackToolCall(paths.logsDirectory, await logMaxBytes(), name),
  });
  return { paths, env, credentials, logger, fileHandlers, createClient, bindHistoryFailureReporter, settingsStore, configManager, featureFlagManager, searchManager, toolHistory, usageTracker, fuzzySearchLogger, dispatcher, capture, context };
}

function sanitizeError(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(deviceToken|token|secret)(["'=:\s]+)[^\s,}]+/gi, '$1$2[redacted]');
}

const requireFromHere = createRequire(import.meta.url);
const yaml = (value: unknown): string => {
  const codec = requireFromHere('js-yaml') as { safeDump(value: unknown, options: { noRefs: boolean }): string };
  return codec.safeDump(value, { noRefs: true });
};

async function createAgentDiagnostics(services: AgentConnectionServices) {
  const { paths, env } = services;
  const resolved = resolveAgentSettings((await services.settingsStore.read()).settings, env);
  const settings = resolved.diagnostics;
  const directory = env.BRC_DIAGNOSTICS_DIR || path.join(paths.root, 'diagnostics');
  const enabled = settings.enabled;
  const instanceId = env.BRC_MANAGED_ID ?? String(process.pid);
  const functions = enabled ? new FunctionTiming() : undefined;
  if (functions) {
    for (const url of [
      new URL('./diagnostics-manifest.json', import.meta.url),
      new URL('./diagnostics-manifest.json', import.meta.resolve('brc-shared')),
    ]) {
      try {
        const manifest = JSON.parse(await readFile(url, 'utf8')) as {
          functions?: Array<{ id: string; name: string; file: string; line: number; kind: 'sync' | 'async' }>;
        };
        for (const entry of manifest.functions ?? []) functions.register(entry.id, entry);
      } catch {}
    }
  }
  const probe = functions ? installFunctionProbe(functions) : undefined;
  const resources = functions ? new NodeResourceSampler({ intervalMs: settings.resourceSampleMs }) : undefined;
  const store = functions && directory ? new FileSnapshotStore({
    directory, staleAfterMs: Math.max(settings.functionSnapshotMs * 3, 60_000),
  }) : undefined;
  const session = functions && resources && store ? new DiagnosticSession({
    service: 'agent', instanceId, store, functions, resources, snapshotIntervalMs: settings.functionSnapshotMs,
  }) : undefined;
  const maxBytes = resolved.logs.rotateMiB * 1024 * 1024;
  const log = functions ? new FileDiagnosticLog(path.join(paths.logsDirectory, 'agent-diagnostics.log'), {
    maxRecordBytes: settings.maxRecordBytes, maxBytes,
  }) : undefined;
  const runtime = createDiagnosticsRuntime({ enabled, component: 'agent', instanceId, functions, resources, session, log });
  let stopped: Promise<void> | undefined;
  return {
    ...runtime,
    stop() {
      stopped ??= runtime.stop().finally(() => probe?.uninstall());
      return stopped;
    },
  };
}

const argv = process.argv.slice(2);
let format: 'table' | 'plain' | 'json' | 'yaml' = argv.includes('--json') || argv.includes('--output=json')
  || argv.some((value, index) => (value === '--output' || value === '-o') && argv[index + 1] === 'json') ? 'json' : 'plain';
let quiet = false;
let verbose = false;

async function run(): Promise<CliResult | null> {
  const invocation = parseAgentInvocation(argv);
  format = invocation.format;
  quiet = invocation.quiet;
  verbose = invocation.verbose;
  if (invocation.noTelemetry || invocation.offline) process.env.DO_NOT_TRACK = '1';
  if (invocation.command === 'connect' && invocation.preview) {
    return cliSuccess({ action: 'connect', changed: false, preview: true, relay: invocation.relay ?? null });
  }
  if (invocation.command === 'credentials logout' || (invocation.command === 'service install' && !invocation.preview)) {
    return runAgentLocalCommand(invocation, undefined, createAgentCredentials({ ...process.env }));
  }
  if (invocation.command !== 'connect' && (invocation.command !== 'config allow-dir' || invocation.preview)) {
    return runAgentLocalCommand(invocation);
  }
  const services = await configureAgentServices();
  if (invocation.command !== 'connect') return runAgentLocalCommand(invocation, services.configManager);
  const { runAgentConnection } = await import('./adapters/transport/connection.js');
  const diagnostics = await createAgentDiagnostics(services);
  try {
    await runAgentConnection(invocation, services, diagnostics, createServer());
  } catch (error) {
    try {
      await diagnostics.stop();
    } catch (shutdownError) {
      if (shutdownError !== error && !(error instanceof AggregateError && error.errors.includes(shutdownError))) {
        const primary = error instanceof Error ? error.message : String(error);
        const secondary = shutdownError instanceof Error ? shutdownError.message : String(shutdownError);
        throw new AggregateError([error, shutdownError], `${primary}; diagnostics shutdown failed: ${secondary}`, { cause: error });
      }
    }
    throw error;
  }
  return null;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
try {
  const result = await run();
  if (result) process.exitCode = renderCliResult(result, { format, quiet, verbose, stringifyYaml: yaml }, {
    stdout: (data) => process.stdout.write(data),
    stderr: (data) => process.stderr.write(data),
  });
} catch (error) {
  const primary = error instanceof AggregateError && error.cause ? error.cause : error;
  const result = cliFailure(toCliError(primary, sanitizeError(error instanceof Error ? error.message : String(error))));
  process.exitCode = renderCliResult(result, { format, quiet, verbose, stringifyYaml: yaml }, {
    stdout: (data) => process.stdout.write(data),
    stderr: (data) => process.stderr.write(data),
  });
}
}
