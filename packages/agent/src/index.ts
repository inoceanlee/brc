/** BRC agent library entry. */
export * from './context.js';
export { createToolDispatcher } from './adapters/mcp/dispatcher.js';
export { WsClient, type WsClientOptions } from './adapters/transport/ws-client.js';
export { VERSION as CORE_VERSION } from './core/version.js';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BRC_SETTING_KEYS, FileSettingsLock, YamlSettingsStore } from 'brc-shared';
import { ConfigStorage } from './adapters/storage/config-storage.js';
import { resolveAgentPaths } from './adapters/storage/agent-paths.js';
import { CredentialStore } from './adapters/storage/credential-store.js';
import { migrateCredentialFile } from './adapters/storage/credential-migration.js';
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
import { WsClient, type WsClientOptions } from './adapters/transport/ws-client.js';
import { VERSION } from './core/version.js';
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
      const defaultRoot = resolveAgentPaths({ ...env, BRC_DATA_ROOT: undefined }).root;
      if (path.normalize(paths.root).toLowerCase() === path.normalize(defaultRoot).toLowerCase()) {
        migrateCredentialFile(path.join(paths.legacyDirectory, 'device.json'), path.dirname(paths.credentialsFile), legacyStore, credentialStore);
      }
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
  const toolHistory = new ToolHistory(new ToolHistoryStorage(paths.historyDirectory), paths, env, reportHistoryFailure);
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
