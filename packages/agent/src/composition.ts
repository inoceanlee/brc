import type { SettingsStorePort } from 'brc-shared';
import type { AgentConfigManager } from './adapters/storage/config-manager.js';
import type { FeatureFlagManager } from './adapters/network/feature-flags.js';
import type { SearchManager } from './adapters/system/search-manager.js';
import type { ToolHistory } from './adapters/telemetry/toolHistory.js';
import type { UsageTracker } from './adapters/telemetry/usageTracker.js';
import type { FuzzySearchLogger } from './adapters/telemetry/fuzzySearchLogger.js';
import type { Capture } from './adapters/telemetry/capture.js';
import type { ToolDispatcher } from './adapters/mcp/dispatcher.js';
import type { AgentContext } from './context.js';
import type { AgentPaths } from './adapters/storage/agent-paths.js';
import type { DeviceCredentials } from './adapters/storage/credential-store.js';
import type { AgentLogger } from './adapters/telemetry/logger.js';
import type { FileHandlerFactory } from './adapters/filesystem/files/factory.js';
import type { WsClient, WsClientOptions } from './adapters/transport/ws-client.js';

export interface AgentCredentials {
  load(): DeviceCredentials | null;
  save(credentials: DeviceCredentials): void;
  exists(): boolean;
  clear(): boolean;
  filename: string;
}

export interface AgentServices {
  paths: AgentPaths;
  logger: AgentLogger;
  fileHandlers: FileHandlerFactory;
  createClient(options: WsClientOptions): WsClient;
  env: NodeJS.ProcessEnv;
  credentials: AgentCredentials;
  bindHistoryFailureReporter(report: (message: string) => void): () => void;
  settingsStore: SettingsStorePort;
  configManager: AgentConfigManager;
  featureFlagManager: FeatureFlagManager;
  searchManager: SearchManager;
  toolHistory: ToolHistory;
  usageTracker: UsageTracker;
  fuzzySearchLogger: FuzzySearchLogger;
  dispatcher: ToolDispatcher;
  capture: Capture;
  context: AgentContext;
}