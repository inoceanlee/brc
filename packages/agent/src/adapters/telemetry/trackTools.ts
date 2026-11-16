import path from 'node:path';
import { appendRotatingLog } from 'brc-shared';

export async function trackToolCall(logsDirectory: string, maxBytes: number, toolName: string, _args?: unknown): Promise<void> {
  const logFile = path.join(logsDirectory, 'agent-tool-calls.log');
  const safeName = toolName.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  const event = { timestamp: new Date().toISOString(), tool: safeName };
  try {
    await appendRotatingLog(logFile, JSON.stringify(event) + '\n', maxBytes);
  } catch {
    process.stderr.write('Agent tool-call metadata logging failed.\n');
  }
}
