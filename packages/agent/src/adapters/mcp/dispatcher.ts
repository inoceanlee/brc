/**
 * BRC agent tool dispatcher: name -> handler, ported from upstream server.ts CallTool switch.
 * Returns MCP-shaped results; errors become { isError: true } text blocks (never throws).
 */
import * as handlers from './handlers/index.js';
import { getConfig, setConfigValue } from './tools/config.js';
import { getUsageStats } from './handlers/usage.js';
import { buildToolDefinitions, EXCLUDED_TOOLS, type ToolDefinition } from './tool-definitions.js';
import type { AgentConfigManager } from '../storage/config-manager.js';
import type { FeatureFlagManager } from '../network/feature-flags.js';
import type { SearchManager } from '../system/search-manager.js';
import type { ToolHistory } from '../telemetry/toolHistory.js';
import type { UsageTracker } from '../telemetry/usageTracker.js';
import type { FuzzySearchLogger } from '../telemetry/fuzzySearchLogger.js';
import type { FilesystemDependencies } from '../filesystem/filesystem.js';
import type { TerminalDependencies } from '../terminal/improved-process-tools.js';
import type { TransferDependencies } from './handlers/transfer-handlers.js';
import type { TextLogPort, ToolResult } from 'brc-shared';
import { textLogToStderr } from '../telemetry/logger.js';

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;
export interface ToolDispatcher {
  callTool(name: string, args: Args): Promise<ToolResult>;
  listTools(): ToolDefinition[];
  hasTool(name: string): boolean;
  stop(): Promise<void>;
}


export interface ToolDispatcherDependencies {
  configManager: AgentConfigManager;
  featureFlagManager: FeatureFlagManager;
  searchManager: SearchManager;
  toolHistory: ToolHistory;
  usageTracker: UsageTracker;
  fuzzySearchLogger: FuzzySearchLogger;
  filesystem: FilesystemDependencies;
  terminal: TerminalDependencies;
  transfer: TransferDependencies;
  currentClient: { name: string; version: string };
  log?: TextLogPort;
  logHistoryFailure: () => void;
  trackToolCall: (name: string) => Promise<void>;
}

export function createToolDispatcher(deps: ToolDispatcherDependencies): ToolDispatcher {
const pending = new Set<Promise<ToolResult>>();
const pendingUsage = new Set<Promise<void>>();
const usageFailures: unknown[] = [];
let additionalUsageFailures = 0;
function trackUsage(operation: Promise<unknown>): void {
  const tracked = operation.then(() => undefined, () => {
    (deps.log ?? textLogToStderr()).error('Agent usage storage write failed.');
    if (usageFailures.length < 16) usageFailures.push(new Error('Agent usage storage write failed.'));
    else additionalUsageFailures++;
  });
  pendingUsage.add(tracked);
  void tracked.then(() => pendingUsage.delete(tracked));
}
let stopping = false;
const TOOL_HANDLERS: Record<string, Handler> = {
  get_config: () => getConfig(deps),
  set_config_value: (a) => setConfigValue(a, deps.configManager, deps.log),
  get_usage_stats: () => getUsageStats(deps.usageTracker),
  get_recent_tool_calls: (a) => handlers.handleGetRecentToolCalls(a, deps.toolHistory),
  start_process: (a) => handlers.handleStartProcess(a, deps.terminal),
  read_process_output: (a) => handlers.handleReadProcessOutput(a, deps.terminal),
  interact_with_process: (a) => handlers.handleInteractWithProcess(a, deps.terminal),
  force_terminate: (a) => handlers.handleForceTerminate(a, deps.terminal),
  list_sessions: () => handlers.handleListSessions(deps.terminal),
  list_processes: () => handlers.handleListProcesses(),
  kill_process: (a) => handlers.handleKillProcess(a),
  read_file: (a) => handlers.handleReadFile(a, deps.filesystem),
  read_multiple_files: (a) => handlers.handleReadMultipleFiles(a, deps.filesystem),
  write_file: (a) => handlers.handleWriteFile(a, deps.filesystem),
  write_pdf: (a) => handlers.handleWritePdf(a, deps.filesystem),
  create_directory: (a) => handlers.handleCreateDirectory(a, deps.filesystem),
  list_directory: (a) => handlers.handleListDirectory(a, deps.filesystem),
  move_file: (a) => handlers.handleMoveFile(a, deps.filesystem),
  prepare_file_transfer: (a) => handlers.handlePrepareFileTransfer(a, deps.transfer),
  send_file_transfer: (a) => handlers.handleSendFileTransfer(a, deps.filesystem),
  receive_file_transfer: (a) => handlers.handleReceiveFileTransfer(a, deps.transfer),
  get_file_info: (a) => handlers.handleGetFileInfo(a, deps.filesystem),
  edit_block: (a) => handlers.handleEditBlock(a, { ...deps.filesystem, fuzzySearchLogger: deps.fuzzySearchLogger }),
  start_search: (a) => handlers.handleStartSearch(a, deps.searchManager, deps.filesystem.capture),
  get_more_search_results: (a) => handlers.handleGetMoreSearchResults(a, deps.searchManager),
  stop_search: (a) => handlers.handleStopSearch(a, deps.searchManager),
  list_searches: () => handlers.handleListSearches(deps.searchManager),
};

let cachedDefs: ToolDefinition[] | null = null;

function listTools(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = buildToolDefinitions().filter((t) => t.name in TOOL_HANDLERS && !EXCLUDED_TOOLS.has(t.name));
  }
  return cachedDefs;
}

function hasTool(name: string): boolean {
  return name in TOOL_HANDLERS;
}

async function executeTool(name: string, args: Args): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const started = Date.now();
  let result: ToolResult;
  try {
    result = (await handler(args ?? {})) as ToolResult;
    const tracking = result.isError ? deps.usageTracker.trackFailure(name) : deps.usageTracker.trackSuccess(name);
    trackUsage(tracking);
  } catch (err) {
    trackUsage(deps.usageTracker.trackFailure(name));
    const message = err instanceof Error ? err.message : String(err);
    result = { content: [{ type: 'text', text: `Error in ${name}: ${message}` }], isError: true };
  }
  try {
    await deps.trackToolCall(name);
  } catch {
    process.stderr.write('Agent tool-call metadata logging failed.\n');
  }
  if (name !== 'get_recent_tool_calls' && name !== 'track_ui_event') {
    try {
      deps.toolHistory.addCall(name, {}, { content: [], isError: result.isError }, Date.now() - started);
    } catch {
      try {
        deps.logHistoryFailure();
      } catch {

      }
    }
  }
  return result;
}
function callTool(name: string, args: Args): Promise<ToolResult> {
  if (stopping) return Promise.resolve({ content: [{ type: 'text', text: 'Agent is stopping.' }], isError: true });
  const call = executeTool(name, args);
  pending.add(call);
  void call.then(() => pending.delete(call), () => pending.delete(call));
  return call;
}

async function stop(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...pending]);
  await Promise.all([...pendingUsage]);
  if (usageFailures.length) throw new AggregateError(usageFailures, `Agent usage tracking failed${additionalUsageFailures ? ` (${additionalUsageFailures} additional failures)` : ''}.`);
}

return { callTool, listTools, hasTool, stop };
}