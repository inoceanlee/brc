import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  createShellEncodingDecoder,
  encodeShellInput,
  getShellProbeCommand,
  SHELL_PROBE_OUTPUT_LIMIT_BYTES,
  SHELL_PROBE_TIMEOUT_MS,
  validateCmdCommand,
  ShellEncodingProbe,
  type ShellEncodingInfo,
} from './terminal-encoding.js';

export interface FeedResult {
  readonly text: string;
  readonly ready: boolean;
  readonly handshake?: Buffer;
  readonly earlyStderr?: string;
  toString(): string;
  valueOf(): string;
}

export class ShellProbeFeedResult implements FeedResult {
  constructor(
    public readonly text: string,
    public readonly ready: boolean,
    public readonly handshake?: Buffer,
    public readonly earlyStderr?: string,
  ) {}

  toString(): string {
    return this.text;
  }

  valueOf(): string {
    return this.text;
  }
}

export interface ShellEncodingSession {
  readonly wrappedCommand: string;
  readonly commandEnvironment: Readonly<Record<string, string>>;
  readonly command: string;
  readonly marker: string;
  readonly probeRequired: boolean;
  readonly isReady: boolean;
  readonly encodingInfo?: ShellEncodingInfo;
  readonly inputEncoding: string;
  readonly outputEncoding: string;

  feedStdout(chunk: Buffer): FeedResult;
  feedStderr(chunk: Buffer): string;
  endStdout(chunk?: Buffer): string;
  endStderr(chunk?: Buffer): string;
  encodeInput(text: string): Buffer;
  onReady(callback: (info: ShellEncodingInfo, handshake: Buffer) => void): this;
  onTimeout(callback: (error: Error) => void): this;
  onError(callback: (error: Error) => void): this;
  dispose(): void;
}

export class DefaultShellEncodingSession implements ShellEncodingSession {
  readonly command: string;
  readonly timeoutMs: number;
  readonly probeShell: 'powershell' | 'cmd' | 'posix' | null;
  readonly marker: string;
  readonly wrappedCommand: string;
  readonly commandEnvironment: Readonly<Record<string, string>>;
  readonly probeRequired: boolean;

  private probe: ShellEncodingProbe | null = null;
  private ready: boolean = false;
  private disposed: boolean = false;
  private info?: ShellEncodingInfo;
  private stdoutDecoder: { write(chunk: Buffer): string; end(chunk?: Buffer): string };
  private stderrDecoder: { write(chunk: Buffer): string; end(chunk?: Buffer): string };
  private stderrPending: Buffer = Buffer.alloc(0);
  private timeoutTimer: NodeJS.Timeout | null = null;

  private readonly readyCallbacks: Array<(info: ShellEncodingInfo, handshake: Buffer) => void> = [];
  private readonly timeoutCallbacks: Array<(error: Error) => void> = [];
  private readonly errorCallbacks: Array<(error: Error) => void> = [];

  constructor(
    command: string,
    timeoutMs: number = SHELL_PROBE_TIMEOUT_MS,
    probeShell: 'powershell' | 'cmd' | 'posix' | null,
    marker?: string,
  ) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.probeShell = probeShell;
    this.probeRequired = probeShell !== null;
    this.marker = this.probeRequired ? (marker ?? `BRC_PROBE_${randomBytes(16).toString('hex')}`) : '';

    if (this.probeRequired) {
      const cmdVariable = this.probeShell === 'cmd' ? `BRC_CMD_${this.marker}` : null;
      if (cmdVariable) validateCmdCommand(this.command);
      this.commandEnvironment = cmdVariable ? { [cmdVariable]: this.command } : {};
      this.probe = new ShellEncodingProbe(this.marker, SHELL_PROBE_OUTPUT_LIMIT_BYTES, this.probeShell!);
      this.wrappedCommand = getShellProbeCommand(this.probeShell!, this.marker, this.command, cmdVariable ?? undefined);
      this.ready = false;
      this.stdoutDecoder = createShellEncodingDecoder('utf-8');
      this.stderrDecoder = createShellEncodingDecoder('utf-8');
      if (this.timeoutMs > 0) {
        this.timeoutTimer = setTimeout(() => this.handleTimeout(), this.timeoutMs);
      }
    } else {
      this.probe = null;
      this.commandEnvironment = {};
      this.wrappedCommand = this.command;
      this.ready = true;
      this.stdoutDecoder = createShellEncodingDecoder('utf-8');
      this.stderrDecoder = createShellEncodingDecoder('utf-8');
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  get encodingInfo(): ShellEncodingInfo | undefined {
    return this.info;
  }

  get inputEncoding(): string {
    return this.info?.consoleInput ?? 'utf-8';
  }

  get outputEncoding(): string {
    return this.info?.consoleOutput ?? 'utf-8';
  }

  feedStdout(chunk: Buffer): FeedResult {
    if (this.disposed) {
      return new ShellProbeFeedResult('', this.ready);
    }

    if (this.ready || !this.probe) {
      const text = this.stdoutDecoder.write(chunk);
      return new ShellProbeFeedResult(text, true);
    }

    try {
      const detected = this.probe.push(Buffer.from(chunk));
      if (detected.state === 'pending') {
        return new ShellProbeFeedResult('', false);
      }

      this.clearTimeoutTimer();
      this.info = detected.info!;
      this.stdoutDecoder = createShellEncodingDecoder(this.info.consoleOutput);
      this.stderrDecoder = createShellEncodingDecoder(this.info.consoleOutput);

      const handshake = encodeShellInput('Y\n', this.info.consoleInput);
      const prefix = Buffer.concat([detected.stdout ?? Buffer.alloc(0), detected.trailing ?? Buffer.alloc(0)]);
      const text = this.stdoutDecoder.write(prefix);

      let earlyStderr: string | undefined;
      if (this.stderrPending.length > 0) {
        earlyStderr = this.stderrDecoder.write(this.stderrPending);
        this.stderrPending = Buffer.alloc(0);
      }

      this.ready = true;

      for (const cb of this.readyCallbacks) {
        try {
          cb(this.info, handshake);
        } catch {
          // ignore callback error
        }
      }

      return new ShellProbeFeedResult(text, true, handshake, earlyStderr);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleError(err);
      throw err;
    }
  }

  feedStderr(chunk: Buffer): string {
    if (this.disposed) {
      return '';
    }

    if (this.ready || !this.probe) {
      return this.stderrDecoder.write(Buffer.from(chunk));
    }

    this.stderrPending = Buffer.concat([this.stderrPending, Buffer.from(chunk)]);
    if (this.stderrPending.length > SHELL_PROBE_OUTPUT_LIMIT_BYTES) {
      const err = new Error('shell encoding probe stderr exceeded limit');
      this.handleError(err);
      throw err;
    }
    return '';
  }

  endStdout(chunk?: Buffer): string {
    return this.stdoutDecoder.end(chunk);
  }

  endStderr(chunk?: Buffer): string {
    if (!this.ready && this.stderrPending.length > 0) {
      const early = this.stderrDecoder.write(this.stderrPending);
      this.stderrPending = Buffer.alloc(0);
      return early + this.stderrDecoder.end(chunk);
    }
    return this.stderrDecoder.end(chunk);
  }

  encodeInput(text: string): Buffer {
    return encodeShellInput(text, this.inputEncoding);
  }

  onReady(callback: (info: ShellEncodingInfo, handshake: Buffer) => void): this {
    this.readyCallbacks.push(callback);
    if (this.ready && this.info) {
      callback(this.info, encodeShellInput('Y\n', this.info.consoleInput));
    }
    return this;
  }

  onTimeout(callback: (error: Error) => void): this {
    this.timeoutCallbacks.push(callback);
    return this;
  }

  onError(callback: (error: Error) => void): this {
    this.errorCallbacks.push(callback);
    return this;
  }

  private handleTimeout(): void {
    if (this.ready || this.disposed) return;
    this.clearTimeoutTimer();
    this.disposed = true;
    this.stderrPending = Buffer.alloc(0);
    const error = new Error(`shell encoding probe timed out after ${this.timeoutMs}ms`);
    for (const cb of this.timeoutCallbacks) {
      try {
        cb(error);
      } catch {
        // ignore
      }
    }
  }

  private handleError(error: Error): void {
    this.clearTimeoutTimer();
    this.disposed = true;
    this.stderrPending = Buffer.alloc(0);
    for (const cb of this.errorCallbacks) {
      try {
        cb(error);
      } catch {
        // ignore
      }
    }
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  dispose(): void {
    this.clearTimeoutTimer();
    this.stderrPending = Buffer.alloc(0);
    this.disposed = true;
  }
}

export { DefaultShellEncodingSession as ShellEncodingSessionImpl };

export class ShellEncodingCoordinator {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly shellPath?: string,
  ) {}

  resolveProbeShell(): 'powershell' | 'cmd' | 'posix' | null {
    if (this.platform === 'win32') {
      if (!this.shellPath) {
        return 'cmd';
      }
      const shellName = path.win32.basename(this.shellPath).toLowerCase();
      if (shellName === 'pwsh' || shellName === 'pwsh.exe' || shellName === 'powershell' || shellName === 'powershell.exe') {
        return 'powershell';
      }
      if (shellName === 'cmd' || shellName === 'cmd.exe') {
        return 'cmd';
      }
      if (shellName === 'bash' || shellName === 'bash.exe' || shellName === 'sh' || shellName === 'sh.exe' || shellName === 'zsh' || shellName === 'zsh.exe') {
        return 'posix';
      }
      return null;
    }

    if (this.shellPath) {
      const shellName = path.basename(this.shellPath).toLowerCase();
      if (shellName === 'pwsh' || shellName === 'pwsh.exe' || shellName === 'powershell' || shellName === 'powershell.exe') {
        return 'powershell';
      }
      if (shellName === 'cmd' || shellName === 'cmd.exe') {
        return 'cmd';
      }
      return 'posix';
    }
    return 'posix';
  }

  createSession(command: string, timeoutMs: number = SHELL_PROBE_TIMEOUT_MS): ShellEncodingSession {
    const probeShell = this.resolveProbeShell();
    return new DefaultShellEncodingSession(command, timeoutMs, probeShell);
  }
}
