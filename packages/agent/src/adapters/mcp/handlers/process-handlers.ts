import { 
    listProcesses,
    killProcess
} from '../../../core/tools/process.js';

import { 
    KillProcessArgsSchema
} from '../../../core/tools/schemas.js';

import { ServerResult } from '../../../core/types.js';

/**
 * Handle list_processes command
 */
export async function handleListProcesses(): Promise<ServerResult> {
    return listProcesses();
}

/**
 * Handle kill_process command
 */
export async function handleKillProcess(args: unknown): Promise<ServerResult> {
    const parsed = KillProcessArgsSchema.parse(args);
    return killProcess(parsed);
}
