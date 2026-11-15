import type { TraceSink, TraceSpan, TraceStatus } from './ports.js';

export type DiagnosticStatus = TraceStatus;

export interface TraceStage {
  stage: string;
  service?: string;
  status: DiagnosticStatus;
  errorCode?: string;
  startMs: number;
  durationMs: number;
}

export interface TraceSummary {
  traceSchema: 1;
  runId: string;
  command: string;
  startedAt: string;
  status: DiagnosticStatus;
  errorCode?: string;
  durationMs: number;
  accountedMs: number;
  unaccountedMs: number;
  stages: TraceStage[];
}

function coveredDuration(intervals: readonly TraceStage[]): number {
  const ordered = intervals
    .map((stage) => [stage.startMs, stage.startMs + stage.durationMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let boundary = 0;
  for (const [start, end] of ordered) {
    if (end > boundary) covered += Math.max(0, end - Math.max(start, boundary));
    boundary = Math.max(boundary, end);
  }
  return covered;
}

class RecorderSpan implements TraceSpan {
  private ended = false;

  constructor(
    readonly stage: string,
    private readonly service: string | undefined,
    private readonly began: number,
    private readonly clock: () => number,
    private readonly origin: number,
    private readonly onEnd: (span: RecorderSpan, status: TraceStatus, errorCode?: string) => void,
  ) {}

  end(status: DiagnosticStatus = 'ok', errorCode?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(this, status, errorCode);
  }

  toStage(): TraceStage {
    return {
      stage: this.stage,
      ...(this.service ? { service: this.service } : {}),
      status: 'ok',
      startMs: Math.max(0, this.began - this.origin),
      durationMs: Math.max(0, this.clock() - this.began),
    };
  }

  get finished(): boolean {
    return this.ended;
  }
}

export class TraceRecorder implements TraceSink {
  private readonly origin: number;
  private readonly stages: TraceStage[] = [];
  private readonly open = new Set<RecorderSpan>();
  private result: TraceSummary | undefined;

  constructor(
    private readonly command: string,
    private readonly runId: string,
    private readonly clock: () => number = () => performance.now(),
    private readonly startedAt: string = new Date().toISOString(),
  ) {
    this.origin = clock();
  }

  begin(stage: string, service?: string): TraceSpan {
    if (this.result) throw new Error('Trace already finished.');
    const span = new RecorderSpan(stage, service, this.clock(), this.clock, this.origin, (closed, status, errorCode) => {
      this.open.delete(closed);
      const record = closed.toStage();
      record.status = status;
      if (errorCode) record.errorCode = errorCode;
      this.stages.push(record);
    });
    this.open.add(span);
    return span;
  }

  async span<T>(stage: string, operation: () => Promise<T>, service?: string): Promise<T> {
    const span = this.begin(stage, service);
    try {
      const result = await operation();
      span.end('ok');
      return result;
    } catch (error) {
      span.end('failed', errorCode(error));
      throw error;
    }
  }

  finish(status: DiagnosticStatus, errorCode?: string): TraceSummary {
    if (this.result) return this.result;
    const unresolved = status === 'ok' ? 'failed' : status;
    for (const span of [...this.open]) span.end(unresolved, errorCode ?? 'UNFINISHED_STAGE');
    const durationMs = Math.max(0, this.clock() - this.origin);
    const accountedMs = Math.min(durationMs, coveredDuration(this.stages));
    this.result = {
      traceSchema: 1,
      runId: this.runId,
      command: this.command,
      startedAt: this.startedAt,
      status,
      ...(errorCode ? { errorCode } : {}),
      durationMs: Math.round(durationMs * 1000) / 1000,
      accountedMs: Math.round(accountedMs * 1000) / 1000,
      unaccountedMs: Math.round(Math.max(0, durationMs - accountedMs) * 1000) / 1000,
      stages: this.stages.map((stage) => ({
        ...stage,
        startMs: Math.round(stage.startMs * 1000) / 1000,
        durationMs: Math.round(stage.durationMs * 1000) / 1000,
      })),
    };
    return this.result;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 64);
  }
  return undefined;
}
