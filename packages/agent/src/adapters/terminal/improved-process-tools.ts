import { MAX_BUFFERED_OUTPUT_CHARS, type TerminalManager } from './terminal-manager.js';
import type { CommandManager } from './command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from '../mcp/schemas.js';
import { ServerResult } from '../../core/types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../system/process-detection.js';
import * as os from 'os';
import type { AgentConfigManager } from '../storage/config-manager.js';
import { AGENT_DEFAULTS } from '../../core/config.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export interface TerminalDependencies {
  configManager: Pick<AgentConfigManager, 'getConfig'>;
  commandManager: CommandManager;
  terminalManager: TerminalManager;
  capture: (event: string, properties?: unknown) => Promise<void>;
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');


/**
 * Execute Node.js code via temp file (fallback when Python unavailable)
 * Creates temp .mjs file in MCP directory for ES module import access
 */
async function executeNodeCode(code: string, timeout_ms: number = 30000): Promise<ServerResult> {
  const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  try {
    await fs.writeFile(tempFile, code, 'utf8');

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const proc = spawn(process.execPath, [tempFile], {
        cwd: mcpRoot,
        timeout: timeout_ms,
        windowsHide: true  
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
      });
    });


    await fs.unlink(tempFile).catch(() => {});

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: result.stdout || '(no output)'
      }]
    };

  } catch (error) {

    await fs.unlink(tempFile).catch(() => {});

    return {
      content: [{
        type: "text",
        text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export async function startProcess(args: unknown, { configManager, commandManager, terminalManager, capture }: TerminalDependencies): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const commands = commandManager.extractCommands(parsed.data.command).join(', ');
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command),
      commands: commands
    });
  } catch (error) {
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command)
    });
  }

  const isAllowed = await commandManager.validateCommand(parsed.data.command);
  if (!isAllowed) {
    return {
      content: [{ type: "text", text: `Error: Command not allowed: ${parsed.data.command}` }],
      isError: true,
    };
  }

  const commandToRun = parsed.data.command;


  if (commandToRun.trim() === 'node:local') {
    const virtualPid = terminalManager.createVirtualNodeSession(parsed.data.timeout_ms || 30000);

    return {
      content: [{
        type: "text",
        text: `Node.js session started with PID ${virtualPid} (MCP server execution)

   IMPORTANT: Each interact_with_process call runs as a FRESH script.
   State is NOT preserved between calls. Include ALL code in ONE call:
   - imports, file reading, processing, and output together.

   Available libraries:
   - ExcelJS for Excel files: import ExcelJS from 'exceljs'
   - All Node.js built-ins: fs, path, http, crypto, etc.

🔄 Ready for code - send complete self-contained script via interact_with_process.`
      }],
    };
  }

  let shellUsed: string | undefined = parsed.data.shell;

  if (!shellUsed) {
    const config = await configManager.getConfig();
    if (config.defaultShell) {
      shellUsed = config.defaultShell;
    } else {
      const isWindows = os.platform() === 'win32';
      if (isWindows && process.env.COMSPEC) {
        shellUsed = process.env.COMSPEC;
      } else if (!isWindows && process.env.SHELL) {
        shellUsed = process.env.SHELL;
      } else {
        shellUsed = isWindows ? 'cmd.exe' : '/bin/sh';
      }
    }
  }

  const result = await terminalManager.executeCommand(
    commandToRun,
    parsed.data.timeout_ms,
    shellUsed,
    parsed.data.verbose_timing || false
  );

  if (result.pid === -1) {
    return {
      content: [{ type: "text", text: result.output }],
      isError: true,
    };
  }


  const processState = analyzeProcessState(result.output, result.pid);

  let statusMessage = '';
  if (processState.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (processState.isFinished) {
    statusMessage = `\n✅ ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (result.isBlocked) {
    statusMessage = '\n⏳ Process is running. Use read_process_output to get more output.';
  }


  let timingMessage = '';
  if (result.timingInfo) {
    timingMessage = formatTimingInfo(result.timingInfo);
  }

  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid} (shell: ${shellUsed})\nInitial output:\n${result.output}${statusMessage}${timingMessage}`
    }],
  };
}

function formatTimingInfo(timing: any): string {
  let msg = '\n\n📊 Timing Information:\n';
  msg += `  Exit Reason: ${timing.exitReason}\n`;
  msg += `  Total Duration: ${timing.totalDurationMs}ms\n`;

  if (timing.timeToFirstOutputMs !== undefined) {
    msg += `  Time to First Output: ${timing.timeToFirstOutputMs}ms\n`;
  }

  if (timing.firstOutputTime && timing.lastOutputTime) {
    msg += `  Output Window: ${timing.lastOutputTime - timing.firstOutputTime}ms\n`;
  }

  if (timing.outputEvents && timing.outputEvents.length > 0) {
    msg += `\n  Output Events (${timing.outputEvents.length} total):\n`;
    timing.outputEvents.forEach((event: any, idx: number) => {
      msg += `    [${idx + 1}] +${event.deltaMs}ms | ${event.source} | ${event.length}b`;
      if (event.matchedPattern) {
        msg += ` | 🎯 ${event.matchedPattern}`;
      }
      msg += `\n       "${event.snippet}"\n`;
    });
  }

  return msg;
}

/**
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 */
export async function readProcessOutput(args: unknown, { configManager, terminalManager }: TerminalDependencies): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }


  const config = await configManager.getConfig();
  const defaultLength = config.fileReadLineLimit ?? AGENT_DEFAULTS.fileReadLineLimit;

  const { 
    pid, 
    timeout_ms = 5000, 
    offset = 0,
    length = defaultLength,
    verbose_timing = false 
  } = parsed.data;


  const startTime = Date.now();


  const session = terminalManager.getSession(pid);
  if (session && offset === 0) {

    const waitForOutput = (): Promise<void> => {
      return new Promise((resolve) => {

        const currentLines = terminalManager.getOutputLineCount(pid) || 0;
        if (currentLines > session.lastReadIndex) {
          resolve();
          return;
        }

        let resolved = false;
        let interval: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timeout) clearTimeout(timeout);
        };

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        };


        interval = setInterval(() => {
          const newLineCount = terminalManager.getOutputLineCount(pid) || 0;
          if (newLineCount > session.lastReadIndex) {
            resolveOnce();
          }
        }, 50);


        timeout = setTimeout(() => {
          resolveOnce();
        }, timeout_ms);
      });
    };

    await waitForOutput();
  }


  const result = terminalManager.readOutputPaginated(pid, offset, length);

  if (!result) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }


  const output = result.lines.join('\n');


  let statusMessage = '';
  if (offset < 0) {

    statusMessage = `[Reading last ${result.readCount} lines (total: ${result.totalLines} lines)]`;
  } else if (offset === 0) {

    if (result.remaining > 0) {
      statusMessage = `[Reading ${result.readCount} new lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
    } else {
      statusMessage = `[Reading ${result.readCount} new lines (total: ${result.totalLines} lines)]`;
    }
  } else {

    statusMessage = `[Reading ${result.readCount} lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
  }




  if (result.evictedLines && result.evictedLines > 0) {
    const capMB = Math.round(MAX_BUFFERED_OUTPUT_CHARS / 1024 / 1024);
    statusMessage += `\n[WARNING: output exceeded the ${capMB}MB buffer cap; the ${result.evictedLines} earliest lines were evicted and cannot be read. Line numbers and totals refer to the retained buffer only]`;
  }


  let processStateMessage = '';
  if (result.isComplete) {
    const runtimeStr = result.runtimeMs !== undefined 
      ? ` (runtime: ${(result.runtimeMs / 1000).toFixed(2)}s)` 
      : '';
    processStateMessage = `\n✅ Process completed with exit code ${result.exitCode}${runtimeStr}`;
  } else if (session) {

    const fullOutput = session.outputLines.join('\n');
    const processState = analyzeProcessState(fullOutput, pid);
    if (processState.isWaitingForInput) {
      processStateMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    }
  }


  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    timingMessage = `\n\n📊 Timing: ${endTime - startTime}ms`;
  }

  const responseText = output || '(No output in requested range)';

  return {
    content: [{
      type: "text",
      text: `${statusMessage}\n\n${responseText}${processStateMessage}${timingMessage}`
    }],
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export async function interactWithProcess(args: unknown, { configManager, terminalManager, capture }: TerminalDependencies): Promise<ServerResult> {
  const parsed = InteractWithProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_interact_with_process_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const {
    pid,
    input,
    timeout_ms = 8000,
    wait_for_prompt = true,
    verbose_timing = false
  } = parsed.data;


  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? AGENT_DEFAULTS.fileReadLineLimit;


  const session = terminalManager.getVirtualNodeSession(pid);
  if (session) {
    capture('server_interact_with_process_node_fallback', {
      pid: pid,
      inputLength: input.length
    });



    const effectiveTimeout = timeout_ms ?? session.timeout_ms;
    return executeNodeCode(input, effectiveTimeout);
  }


  const startTime = Date.now();
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' | 'no_wait' = 'timeout';

  try {
    capture('server_interact_with_process', {
      pid: pid,
      inputLength: input.length
    });



    const outputSnapshot = terminalManager.captureOutputSnapshot(pid);

    const success = terminalManager.sendInputToProcess(pid, input);

    if (!success) {
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.` }],
        isError: true,
      };
    }


    if (!wait_for_prompt) {
      exitReason = 'no_wait';
      let timingMessage = '';
      if (verbose_timing) {
        const endTime = Date.now();
        const timingInfo = {
          startTime,
          endTime,
          totalDurationMs: endTime - startTime,
          exitReason,
          firstOutputTime,
          lastOutputTime,
          timeToFirstOutputMs: undefined,
          outputEvents: undefined
        };
        timingMessage = formatTimingInfo(timingInfo);
      }
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.${timingMessage}`
        }],
      };
    }


    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;


    const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollIntervalMs = 50; 
        const maxAttempts = Math.ceil(timeout_ms / pollIntervalMs);
        let interval: NodeJS.Timeout | null = null;
        let lastOutputLength = 0; 

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };


        interval = setInterval(() => {
          if (resolved) return;


          const newOutput = outputSnapshot 
            ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
            : terminalManager.getNewOutput(pid);

          if (newOutput && newOutput.length > lastOutputLength) {
            const now = Date.now();
            if (!firstOutputTime) firstOutputTime = now;
            lastOutputTime = now;

            if (verbose_timing) {
              outputEvents.push({
                timestamp: now,
                deltaMs: now - startTime,
                source: 'periodic_poll',
                length: newOutput.length - lastOutputLength,
                snippet: newOutput.slice(lastOutputLength, lastOutputLength + 50).replace(/\n/g, '\\n')
              });
            }

            output = newOutput; 
            lastOutputLength = newOutput.length;


            processState = analyzeProcessState(output, pid);


            if (processState.isWaitingForInput) {
              earlyExit = true;
              exitReason = 'early_exit_periodic_check';

              if (verbose_timing && outputEvents.length > 0) {
                outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
              }

              resolveOnce();
              return;
            }


            if (processState.isFinished) {
              exitReason = 'process_finished';
              resolveOnce();
              return;
            }
          }

          attempts++;
          if (attempts >= maxAttempts) {
            exitReason = 'timeout';
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };

    await waitForResponse();


    let cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = !earlyExit && !processState?.isFinished && !processState?.isWaitingForInput;


    let truncationMessage = '';
    const outputLines = cleanOutput.split('\n');
    if (outputLines.length > maxOutputLines) {
      const truncatedLines = outputLines.slice(0, maxOutputLines);
      cleanOutput = truncatedLines.join('\n');
      const remainingLines = outputLines.length - maxOutputLines;
      truncationMessage = `\n\n⚠️ Output truncated: showing ${maxOutputLines} of ${outputLines.length} lines (${remainingLines} hidden). Use read_process_output with offset/length for full output.`;
    }


    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }

    let statusMessage = '';
    if (processState.isWaitingForInput) {
      statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    } else if (processState.isFinished) {
      statusMessage = `\n✅ ${formatProcessStateMessage(processState, pid)}`;
    } else if (timeoutReached) {
      statusMessage = '\n⏱️ Response may be incomplete (timeout reached)';
    }


    let timingMessage = '';
    if (verbose_timing) {
      const endTime = Date.now();
      const timingInfo = {
        startTime,
        endTime,
        totalDurationMs: endTime - startTime,
        exitReason,
        firstOutputTime,
        lastOutputTime,
        timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
        outputEvents: outputEvents.length > 0 ? outputEvents : undefined
      };
      timingMessage = formatTimingInfo(timingInfo);
    }

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
      };
    }


    let responseText = `✅ Input executed in process ${pid}`;

    if (cleanOutput && cleanOutput.trim().length > 0) {
      responseText += `:\n\n📤 Output:\n${cleanOutput}`;
    } else {
      responseText += `.\n📭 (No output produced)`;
    }

    if (statusMessage) {
      responseText += `\n\n${statusMessage}`;
    }

    if (truncationMessage) {
      responseText += truncationMessage;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
      }],
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_interact_with_process_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Force terminate a process
 */
export async function forceTerminate(args: unknown, { terminalManager }: TerminalDependencies): Promise<ServerResult> {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for force_terminate: ${parsed.error}` }],
      isError: true,
    };
  }

  const pid = parsed.data.pid;


  if (terminalManager.removeVirtualNodeSession(pid)) {
    return {
      content: [{
        type: "text",
        text: `Cleared virtual Node.js session ${pid}`
      }],
    };
  }

  const success = terminalManager.forceTerminate(pid);
  return {
    content: [{
      type: "text",
      text: success
        ? `Successfully initiated termination of session ${pid}`
        : `No active session found for PID ${pid}`
    }],
  };
}

/**
 * List active sessions
 */
export async function listSessions({ terminalManager }: TerminalDependencies): Promise<ServerResult> {
  const sessions = terminalManager.listActiveSessions();


  const virtualSessions = Array.from(terminalManager.listVirtualNodeSessions()).map(([pid, session]) => ({
    pid,
    type: 'node:local',
    timeout_ms: session.timeout_ms
  }));

  const realSessionsText = sessions.map(s =>
    `PID: ${s.pid}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
  );

  const virtualSessionsText = virtualSessions.map(s =>
    `PID: ${s.pid} (node:local), Timeout: ${s.timeout_ms}ms`
  );

  const allSessions = [...realSessionsText, ...virtualSessionsText];

  return {
    content: [{
      type: "text",
      text: allSessions.length === 0
        ? 'No active sessions'
        : allSessions.join('\n')
    }],
  };
}