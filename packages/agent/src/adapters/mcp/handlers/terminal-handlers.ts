import { 
    startProcess, 
    readProcessOutput, 
    interactWithProcess,
    forceTerminate, 
    listSessions 
} from '../../terminal/improved-process-tools.js';
import type { TerminalDependencies } from '../../terminal/improved-process-tools.js';

import { 
    StartProcessArgsSchema,
    ReadProcessOutputArgsSchema,
    InteractWithProcessArgsSchema,
    ForceTerminateArgsSchema,
    ListSessionsArgsSchema
} from '../../../core/tools/schemas.js';

import { ServerResult } from '../../../core/types.js';

/**
 * Handle start_process command (improved execute_command)
 */
export async function handleStartProcess(args: unknown, dependencies: TerminalDependencies): Promise<ServerResult> {
    const parsed = StartProcessArgsSchema.parse(args);
    return startProcess(parsed, dependencies);
}

/**
 * Handle read_process_output command (improved read_output)
 */
export async function handleReadProcessOutput(args: unknown, dependencies: TerminalDependencies): Promise<ServerResult> {
    const parsed = ReadProcessOutputArgsSchema.parse(args);
    return readProcessOutput(parsed, dependencies);
}

/**
 * Handle interact_with_process command (improved send_input)
 */
export async function handleInteractWithProcess(args: unknown, dependencies: TerminalDependencies): Promise<ServerResult> {
    return interactWithProcess(args, dependencies);
}

/**
 * Handle force_terminate command
 */
export async function handleForceTerminate(args: unknown, dependencies: TerminalDependencies): Promise<ServerResult> {
    const parsed = ForceTerminateArgsSchema.parse(args);
    return forceTerminate(parsed, dependencies);
}

/**
 * Handle list_sessions command
 */
export async function handleListSessions(dependencies: TerminalDependencies): Promise<ServerResult> {
    return listSessions(dependencies);
}