import { ServerResult } from '../../../core/types.js';
import type { UsageTracker } from '../../telemetry/usageTracker.js';

/**
 * Get usage statistics for debugging and analysis
 */
export async function getUsageStats(usageTracker: UsageTracker): Promise<ServerResult> {
  try {
    const summary = await usageTracker.getUsageSummary();

    return {
      content: [{
        type: "text",
        text: summary
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error retrieving usage stats: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
