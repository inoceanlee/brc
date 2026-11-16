import type { ChildProcess } from 'node:child_process';

export interface TerminalSession {
  pid: number;
  process: ChildProcess;
  outputLines: string[];
  lastReadIndex: number;
  isBlocked: boolean;
  startTime: Date;
  bufferedChars: number;
  evictedLines: number;
  evictedChars: number;
  inputEncoding?: string;
}
