import { spawn } from 'child_process';
import path from 'path';
import { CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from '../../core/types.js';
import { TerminalSession } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from '../../core/config.js';
import type { AgentConfigManager } from '../storage/config-manager.js';
import { analyzeProcessState } from '../system/process-detection.js';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { ShellEncodingCoordinator, type ShellEncodingSession } from './shell-coordinator.js';
import { encodeShellInput } from './terminal-encoding.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  evictedLines: number;        
  evictedChars: number;
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  
const MAX_LINE_CHARS = 1024 * 1024;                  
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       


export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            
  readCount: number;           
  remaining: number;           
  isComplete: boolean;         
  exitCode?: number | null;    
  runtimeMs?: number;          
  evictedLines?: number;       
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  
  
  windowsVerbatim?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  
  
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    return { 
      executable: shellPath, 
      args: ['-Login', '-Command', command],
      useShellOption: false 
    };
  }
  
  
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    return { 
      executable: shellPath, 
      args: ['-Command', command],
      useShellOption: false 
    };
  }
  
  
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return { 
      executable: shellPath, 
      args: ['/d', '/v:on', '/c', command],
      windowsVerbatim: true,
      useShellOption: false 
    };
  }
  
  
  if (shellName.includes('fish')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  
  
  return { 
    executable: command,
    args: [],
    useShellOption: shellPath 
  };
}

export function resolveDynamicShellPath(configuredShell?: string | boolean): string | undefined {
  if (typeof configuredShell === 'string' && configuredShell.trim()) {
    return configuredShell.trim();
  }
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  try {
    const userShell = os.userInfo().shell;
    if (userShell && fs.existsSync(userShell)) return userShell;
  } catch {}
  for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh']) {
    if (fs.existsSync(fallback)) return fallback;
  }
  return undefined;
}
export class TerminalManager {
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  private virtualNodeSessions = new Map<number, { timeout_ms: number }>();
  private virtualPidCounter = -1000;

  constructor(
    private readonly configManager: Pick<AgentConfigManager, 'getConfig'>,
    private readonly capture: (event: string, properties?: unknown) => Promise<void>
  ) {}

  createVirtualNodeSession(timeout_ms: number): number {
    const pid = this.virtualPidCounter--;
    this.virtualNodeSessions.set(pid, { timeout_ms });
    return pid;
  }

  getVirtualNodeSession(pid: number): { timeout_ms: number } | undefined {
    return this.virtualNodeSessions.get(pid);
  }

  removeVirtualNodeSession(pid: number): boolean {
    return this.virtualNodeSessions.delete(pid);
  }

  listVirtualNodeSessions(): IterableIterator<[number, { timeout_ms: number }]> {
    return this.virtualNodeSessions.entries();
  }
  
  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }
    
    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        
        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
    session.process.stdin.write(session.inputEncoding ? encodeShellInput(inputWithNewline, session.inputEncoding) : inputWithNewline);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string, collectTiming: boolean = false): Promise<CommandExecutionResult> {
    
    let shellToUse: string | boolean | undefined = shell;
    if (!shellToUse) {
      try {
        const config = await this.configManager.getConfig();
        shellToUse = config.defaultShell || true;
      } catch (error) {
        
        shellToUse = true;
      }
    }

    
    

    
    let enhancedCommand = command;
    if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
      enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      console.log(`Enhanced SSH command: ${enhancedCommand}`);
    }

  const effectiveShellPath = resolveDynamicShellPath(shellToUse);
  const coordinator = new ShellEncodingCoordinator(process.platform, effectiveShellPath);
  const encodingSession: ShellEncodingSession = coordinator.createSession(enhancedCommand);
  const shellCommand = encodingSession.wrappedCommand;
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;
    
  if (effectiveShellPath) {
      
   spawnConfig = getShellSpawnArgs(effectiveShellPath, shellCommand);
      spawnOptions = {
        env: {
          ...process.env,
          ...encodingSession.commandEnvironment,
          TERM: 'xterm-256color'  
        },
        windowsHide: true  
      };

      
      if (spawnConfig.useShellOption) {
        spawnOptions.shell = spawnConfig.useShellOption;
      }
    } else {
      
      spawnConfig = {
        executable: enhancedCommand,
        args: [],
        useShellOption: shellToUse
      };
      spawnOptions = {
        shell: shellToUse,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        windowsHide: true  
      };
    }

    
    
    
    
    if (process.platform === 'win32' && spawnOptions.env) {
      spawnOptions.env.PATHEXT = getRepairedPathExt();
    }

    
    
    
    
    
    
    
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    let output = '';

    
    
    
    
    
    
    
    
    
    
    
    let forwardProcessError: ((err: Error) => void) | null = null;
    let pendingProcessError: Error | null = null;
    childProcess.on('error', (err: Error) => {
      if (forwardProcessError) {
        forwardProcessError(err);
      } else {
        pendingProcessError = err;
        console.error(`Process error for "${command}": ${err.message}`);
      }
    });

    
    if (!childProcess.pid) {
      
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }

    const session: TerminalSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0
    };

    this.sessions.set(childProcess.pid, session);

    
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
   let commandTimeout: NodeJS.Timeout | null = null;
   let probeTimeout: NodeJS.Timeout | null = null;
   let probeReady = !encodingSession.probeRequired;
      
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
    if (commandTimeout) clearTimeout(commandTimeout);
    if (probeTimeout) clearTimeout(probeTimeout);

        
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

   const startCommandTimeout = () => {
    commandTimeout = setTimeout(() => {
     session.isBlocked = true;
     exitReason = 'timeout';
     resolveOnce({ pid: childProcess.pid!, output, isBlocked: true });
    }, timeoutMs);
   };
   const failProbe = (reason: string) => {
    if (probeReady || resolved) return;
    probeReady = true;
    encodingSession.dispose();
    childProcess.kill();
    exitReason = 'process_exit';
    resolveOnce({ pid: childProcess.pid!, output: 'Shell encoding probe failed: ' + reason, isBlocked: false });
   };
   if (encodingSession.probeRequired) {
    probeTimeout = setTimeout(() => failProbe('timed out'), 5000);
   } else {
    startCommandTimeout();
   }
      
      
      
      forwardProcessError = (err: Error) => {
        this.sessions.delete(childProcess.pid!);
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output: output + `\nProcess error: ${err.message}`,
          isBlocked: false
        });
      };
      
      
      if (pendingProcessError) {
        forwardProcessError(pendingProcessError);
      }

   childProcess.stdout.on('data', (data: Buffer) => {
    let text: string;
    if (encodingSession.probeRequired && !probeReady) {
     try {
      const feed = encodingSession.feedStdout(Buffer.from(data));
      if (!feed.ready) return;
      probeReady = true;
      if (probeTimeout) clearTimeout(probeTimeout);
      if (feed.handshake && childProcess.stdin && !childProcess.stdin.destroyed) {
       childProcess.stdin.write(feed.handshake);
      }
      if (encodingSession.encodingInfo) {
       session.inputEncoding = encodingSession.encodingInfo.consoleInput;
      }
      if (feed.earlyStderr) {
       if (!resolved) output += feed.earlyStderr;
       this.appendToLineBuffer(session, feed.earlyStderr);
      }
      text = feed.text;
      startCommandTimeout();
     } catch (error) {
      failProbe(error instanceof Error ? error.message : String(error));
      return;
     }
    } else {
     text = encodingSession.feedStdout(Buffer.from(data)).text;
    }
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        
        
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        
        this.appendToLineBuffer(session, text);

        
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        
        if (quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

   childProcess.stderr.on('data', (data: Buffer) => {
    if (encodingSession.probeRequired && !probeReady) {
     try {
      encodingSession.feedStderr(Buffer.from(data));
     } catch (error) {
      failProbe(error instanceof Error ? error.message : String(error));
     }
     return;
    }
    const text = encodingSession.feedStderr(Buffer.from(data));
    const now = Date.now();
    if (!firstOutputTime) firstOutputTime = now;
    lastOutputTime = now;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        
        this.appendToLineBuffer(session, text);

        
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      
      periodicCheck = setInterval(() => {
        if (output.trim()) {
          const processState = analyzeProcessState(output, childProcess.pid);
          if (processState.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({
              pid: childProcess.pid!,
              output,
              isBlocked: true
            });
          }
        }
      }, 100);

      
      childProcess.on('close', (code: any) => {
        if (childProcess.pid) {
          
          this.completedSessions.set(childProcess.pid, {
            pid: childProcess.pid,
            outputLines: [...session.outputLines], // Copy line buffer
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars
          });

          
          if (this.completedSessions.size > 100) {
            const oldestKey = Array.from(this.completedSessions.keys())[0];
            this.completedSessions.delete(oldestKey);
          }

          this.sessions.delete(childProcess.pid);
        }
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;

    
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        
        session.outputLines.push(line);
      } else if (i === 0) {
        
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        
        session.outputLines.push(line);
      }
    }
    
    
    session.bufferedChars += text.length;

    
    
    
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    
    
    
    while (session.bufferedChars > MAX_BUFFERED_OUTPUT_CHARS && session.outputLines.length > 1) {
      const dropped = session.outputLines.shift()!;
      const droppedJoinedChars = dropped.length + 1; 
      session.bufferedChars -= droppedJoinedChars;
      session.evictedChars += droppedJoinedChars;
      session.evictedLines++;
      if (session.lastReadIndex > 0) session.lastReadIndex--;
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000): PaginatedOutputResult | null {
    
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        session.lastReadIndex,
        (newIndex) => { session.lastReadIndex = newIndex; },
        false,
        undefined
      );
      result.evictedLines = session.evictedLines;
      return result;
    }

    
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        0,  // Completed sessions don't track read position
        () => {},  // No-op for completed sessions
        true,
        completedSession.exitCode,
        runtimeMs
      );
      result.evictedLines = completedSession.evictedLines;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      
      
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      
      startIndex = lastReadIndex;
      linesToRead = lines.slice(startIndex, startIndex + length);
      
      updateLastRead(Math.min(startIndex + linesToRead.length, totalLines));
    } else {
      
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, totalLines - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      const fullOutput = session.outputLines.join('\n');
      return {
        
        
        
        totalChars: session.evictedChars + fullOutput.length,
        lineCount: session.evictedLines + session.outputLines.length
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number }): string | null {
    
    const session = this.sessions.get(pid);
    if (session) {
      return TerminalManager.outputSinceSnapshot(session.outputLines, session.evictedChars, snapshot.totalChars);
    }

    
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return TerminalManager.outputSinceSnapshot(completedSession.outputLines, completedSession.evictedChars, snapshot.totalChars);
    }

    return null;
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets.
   * If eviction dropped part of the unseen output, returns what the buffer
   * still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(outputLines: string[], evictedChars: number, snapshotTotalChars: number): string {
    const fullOutput = outputLines.join('\n');
    const newChars = evictedChars + fullOutput.length - snapshotTotalChars;
    if (newChars <= 0) {
      return ''; 
    }
    return fullOutput.substring(Math.max(0, fullOutput.length - newChars));
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
  }

  forceTerminate(pid: number): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }

    try {
        session.process.kill('SIGINT');
        setTimeout(() => {
          if (this.sessions.has(pid)) {
            session.process.kill('SIGKILL');
          }
        }, 1000);
        return true;
      } catch (error) {
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.capture('server_request_error', {error: errorMessage, message: `Failed to terminate process ${pid}:`});
        return false;
      }
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}