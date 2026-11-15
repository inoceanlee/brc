import type {
  DiagnosticSnapshot,
  DiagnosticSnapshotPort,
  ResourceSamplePort,
  SnapshotState,
} from './ports.js';
import type { FunctionTiming } from './functions.js';

export interface DiagnosticSessionOptions {
  service: DiagnosticSnapshot['service'];
  instanceId: string;
  pid?: number;
  store: DiagnosticSnapshotPort;
  functions: FunctionTiming;
  resources: ResourceSamplePort;
  snapshotIntervalMs?: number;
  now?: () => Date;
}

/**
 * Periodically publishes a service instance's function and resource
 * statistics as one atomic snapshot, and flushes a final record on shutdown.
 */
export class DiagnosticSession {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly partialFailures = new Set<string>();
  private static readonly MAX_PARTIAL_FAILURES = 8;

  constructor(private readonly options: DiagnosticSessionOptions) {
    this.intervalMs = options.snapshotIntervalMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.capture('running'); }, this.intervalMs);
    this.timer.unref();
  }

  async capture(status: DiagnosticSnapshot['status'] = 'running'): Promise<SnapshotState | 'failed'> {
    let resources;
    try {
      resources = await this.options.resources.sample();
    } catch (error) {
      this.noteFailure(error);
      return 'failed';
    }
    const snapshot: DiagnosticSnapshot = {
      schema: 1,
      service: this.options.service,
      instanceId: this.options.instanceId,
      pid: this.options.pid ?? process.pid,
      capturedAt: this.now().toISOString(),
      status,
      functions: this.options.functions.snapshot(),
      resources,
      ...(this.partialFailures.size ? { partialFailures: [...this.partialFailures] } : {}),
    };
    try {
      await this.options.store.write(snapshot);
      return status === 'exited' ? 'exited' : 'current';
    } catch (error) {
      this.noteFailure(error);
      return 'failed';
    }
  }

  private noteFailure(error: unknown): void {
    const candidate = error as { code?: unknown; message?: unknown } | null;
    const message = typeof candidate?.code === 'string'
      ? candidate.code
      : String(candidate?.message ?? error);
    if (this.partialFailures.size >= DiagnosticSession.MAX_PARTIAL_FAILURES) return;
    this.partialFailures.add(message.slice(0, 128));
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.capture('exited');
  }
}
