/**
 * BRC agent tool dispatcher: name -> handler, ported from upstream server.ts CallTool switch.
 * Returns MCP-shaped results; errors become { isError: true } text blocks (never throws).
 */
import * as handlers from './handlers/index.js';
import { getConfig, setConfigValue } from './tools/config.js';
import { getUsageStats } from './handlers/usage.js';
import { buildToolDefinitions, EXCLUDED_TOOLS, type ToolDefinition } from './tool-definitions.js';
import { usageTracker } from '../telemetry/usageTracker.js';
import { toolHistory } from '../telemetry/toolHistory.js';
import type { ToolResult } from 'brc-shared';

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, Handler> = {
  get_config: () => getConfig(),
  set_config_value: (a) => setConfigValue(a),
  get_usage_stats: () => getUsageStats(),
  get_recent_tool_calls: (a) => handlers.handleGetRecentToolCalls(a),
  start_process: (a) => handlers.handleStartProcess(a),
  read_process_output: (a) => handlers.handleReadProcessOutput(a),
  interact_with_process: (a) => handlers.handleInteractWithProcess(a),
  force_terminate: (a) => handlers.handleForceTerminate(a),
  list_sessions: () => handlers.handleListSessions(),
  list_processes: () => handlers.handleListProcesses(),
  kill_process: (a) => handlers.handleKillProcess(a),
  read_file: (a) => handlers.handleReadFile(a),
  read_multiple_files: (a) => handlers.handleReadMultipleFiles(a),
  write_file: (a) => handlers.handleWriteFile(a),
  write_pdf: (a) => handlers.handleWritePdf(a),
  create_directory: (a) => handlers.handleCreateDirectory(a),
  list_directory: (a) => handlers.handleListDirectory(a),
  move_file: (a) => handlers.handleMoveFile(a),
  prepare_file_transfer: (a) => handlers.handlePrepareFileTransfer(a),
  send_file_transfer: (a) => handlers.handleSendFileTransfer(a),
  receive_file_transfer: (a) => handlers.handleReceiveFileTransfer(a),
  get_file_info: (a) => handlers.handleGetFileInfo(a),
  edit_block: (a) => handlers.handleEditBlock(a),
  start_search: (a) => handlers.handleStartSearch(a),
  get_more_search_results: (a) => handlers.handleGetMoreSearchResults(a),
  stop_search: (a) => handlers.handleStopSearch(a),
  list_searches: () => handlers.handleListSearches(),
};

let cachedDefs: ToolDefinition[] | null = null;

export function listTools(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = buildToolDefinitions().filter((t) => t.name in TOOL_HANDLERS && !EXCLUDED_TOOLS.has(t.name));
  }
  return cachedDefs;
}

export function hasTool(name: string): boolean {
  return name in TOOL_HANDLERS;
}

export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const started = Date.now();
  let result: ToolResult;
  try {
    result = (await handler(args ?? {})) as ToolResult;
    const tracking = result.isError ? usageTracker.trackFailure(name) : usageTracker.trackSuccess(name);
    void tracking.catch((error: unknown) => console.error('Failed to track tool usage:', error));
  } catch (err) {
    void usageTracker.trackFailure(name).catch((error: unknown) => console.error('Failed to track tool usage:', error));
    const message = err instanceof Error ? err.message : String(err);
    result = { content: [{ type: 'text', text: `Error in ${name}: ${message}` }], isError: true };
  }
  if (name !== 'get_recent_tool_calls' && name !== 'track_ui_event') {
    try {
      toolHistory?.addCall(name, {}, { content: [], isError: result.isError }, Date.now() - started);
    } catch {
      // History must not change the tool result.
    }
  }
  return result;
}