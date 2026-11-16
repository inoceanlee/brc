import path from 'node:path';
import { appendRotatingLog } from 'brc-shared';
import { resolveAgentPaths } from '../storage/agent-paths.js';

export async function trackToolCall(toolName: string, _args?: unknown): Promise<void> {
  const logFile = path.join(resolveAgentPaths().logsDirectory, 'agent-tool-calls.log');
  const safeName = toolName.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  const event = { timestamp: new Date().toISOString(), tool: safeName };
  try {
    await appendRotatingLog(logFile, JSON.stringify(event) + '\n');
  } catch {
    process.stderr.write('Agent tool-call metadata logging failed.\n');
  }
}
