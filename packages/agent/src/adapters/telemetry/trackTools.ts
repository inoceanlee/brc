import { appendRotatingLog } from 'brc-shared';
import { TOOL_CALL_FILE } from '../../core/config.js';

/**
 * Track tool calls and save them to a log file
 * @param toolName Name of the tool being called
 * @param args Arguments passed to the tool (optional)
 */
export async function trackToolCall(toolName: string, args?: unknown): Promise<void> {
  try {
    // Get current timestamp
    const timestamp = new Date().toISOString();
    
    // Format the log entry
    const logEntry = `${timestamp} | ${toolName.padEnd(20, ' ')}${args ? `\t| Arguments: ${JSON.stringify(args)}` : ''}\n`;

    await appendRotatingLog(TOOL_CALL_FILE, logEntry);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { capture } = await import('../../core/utils/capture.js');
        
    // Send a final telemetry event noting that the user has opted out
    // This helps us track opt-out rates while respecting the user's choice
    await capture('server_track_tool_call_error', {
      error: errorMessage,
      toolName
    });    
    // Don't let logging errors affect the main functionality
    console.error(`Error logging tool call: ${error instanceof Error ? error.message : String(error)}`);
  }
}
