import type { TraefikProgressEvent } from './traefik/manager.js';

const MAX_PENDING_STAGE_LINES = 64;

interface ProgressOutput {
  readonly isTTY?: boolean;
  write(text: string, callback?: (error?: Error | null) => void): unknown;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}

export interface TraefikProgressOptions {
  color?: boolean;
  enabled?: boolean;
}

export class TraefikProgress {
  private timer?: NodeJS.Timeout;
  private current?: TraefikProgressEvent;
  private percent?: number;
  private frame = 0;
  private failed = false;
  private interrupted = false;
  private blocked = false;
  private pending?: string;
  private readonly pendingLines: string[] = [];
  private inFlight = 0;
  private settled?: () => void;
  private readonly color: boolean;
  private readonly enabled: boolean;

  constructor(
    private readonly output: ProgressOutput = process.stderr,
    options: TraefikProgressOptions = {},
  ) {
    this.color = options.color ?? true;
    this.enabled = options.enabled ?? true;
    this.output.on?.('error', () => {
      this.failed = true;
      this.blocked = false;
      this.pending = undefined;
      this.pendingLines.length = 0;
      this.settled?.();
    });
  }

  report(event: TraefikProgressEvent): void {
    if (this.interrupted || !this.enabled) return;
    const sameStage = this.current?.operation === event.operation && this.current.stage === event.stage;
    if (event.status === 'started') {
      if (!sameStage) {
        this.stop();
        this.current = event;
        this.percent = undefined;
        if (!this.output.isTTY) {
          this.write(`Traefik ${event.operation}: ${event.stage}\n`);
          return;
        }
        this.timer = setInterval(() => this.render(), 120);
        this.timer.unref();
        this.render();
      }
      if (this.output.isTTY && event.completedBytes !== undefined && event.totalBytes !== undefined
        && Number.isSafeInteger(event.totalBytes) && event.totalBytes > 0
        && Number.isSafeInteger(event.completedBytes) && event.completedBytes >= 0 && event.completedBytes <= event.totalBytes) {
        const percent = Math.floor(event.completedBytes * 100 / event.totalBytes);
        this.percent = Math.max(this.percent ?? 0, percent);
      }
    } else if (sameStage) {
      if (this.output.isTTY && event.status === 'completed' && event.completedBytes !== undefined
        && event.totalBytes !== undefined && event.totalBytes > 0 && event.completedBytes === event.totalBytes) {
        this.percent = 100;
        this.render();
      }
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.write(this.color ? '\r\x1b[2K' : '\r');
    }
    this.current = undefined;
    this.percent = undefined;
  }

  async stopAndWait(): Promise<void> {
    this.interrupted = true;
    this.stop();
    if (this.failed || (!this.blocked && this.pending === undefined && this.pendingLines.length === 0 && this.inFlight === 0)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, 250);
      const self = this;
      function finish() {
        clearTimeout(timeout);
        self.settled = undefined;
        resolve();
      }
      this.settled = () => {
        if (this.failed || (!this.blocked && this.pending === undefined && this.pendingLines.length === 0 && this.inFlight === 0)) finish();
      };
      this.settled();
    });
  }

  private render(): void {
    if (!this.current) return;
    const spinner = ['|', '/', '-', '\\'][this.frame++ % 4];
    const percent = this.percent === undefined ? '' : ` ${this.percent}%`;
    this.write(`${this.color ? '\r\x1b[2K' : '\r'}${spinner} Traefik ${this.current.operation}: ${this.current.stage}${percent}`);
  }

  private write(text: string): void {
    if (this.failed) return;
    if (this.blocked) {
      if (this.output.isTTY) {
        this.pending = text;
      } else if (this.pendingLines.length < MAX_PENDING_STAGE_LINES) {
        this.pendingLines.push(text);
      } else {
        this.failed = true;
        this.pendingLines.length = 0;
        this.settled?.();
      }
      return;
    }
    try {
      this.inFlight++;
      const accepted = this.output.write(text, (error) => {
        this.inFlight--;
        if (error) {
          this.failed = true;
          this.pending = undefined;
          this.pendingLines.length = 0;
          this.blocked = false;
        }
        this.settled?.();
      });
      if (accepted === false && this.output.once) {
        this.blocked = true;
        this.output.once('drain', () => {
          this.blocked = false;
          const pending = this.pending;
          this.pending = undefined;
          if (pending !== undefined) this.write(pending);
          while (!this.blocked && !this.failed && this.pendingLines.length > 0) {
            this.write(this.pendingLines.shift()!);
          }
          this.settled?.();
        });
      }
    } catch {
      this.failed = true;
      this.inFlight = 0;
      this.pending = undefined;
      this.pendingLines.length = 0;
      this.blocked = false;
      this.settled?.();
    }
  }
}

export function installProgressInterruptHandler(progress: TraefikProgress): () => void {
  const interrupt = async () => {
    await progress.stopAndWait();
    process.removeListener('SIGINT', interrupt);
    if (process.platform === 'win32') process.exit(0xC000013A);
    process.kill(process.pid, 'SIGINT');
  };
  process.once('SIGINT', interrupt);
  return () => process.removeListener('SIGINT', interrupt);
}
