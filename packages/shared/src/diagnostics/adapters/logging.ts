import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { appendRotatingLog } from '../../managed-log.js';
import { createDiagnosticEvent, type DiagnosticEventInput } from '../core/event.js';
import type { DiagnosticLogPort } from '../core/ports.js';
import type { TraceSummary } from '../core/recorder.js';
import { withDiagnosticLogLock } from './log-lock.js';

export interface TraceLogOptions {
  maxRecordBytes?: number;
  maxBytes?: number;
}

async function validateDirectory(filename: string): Promise<void> {
  if (!path.isAbsolute(filename)) throw new Error('Diagnostic log path must be absolute.');
  const dir = path.dirname(filename);
  await mkdir(dir, { recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diagnostic log directory must be a plain directory.');
}

function fits(record: string, maxRecordBytes: number): boolean {
  return Buffer.byteLength(record + '\n') <= maxRecordBytes;
}

async function appendRecord(
  filename: string,
  record: string,
  options: TraceLogOptions,
): Promise<void> {
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 128) throw new Error('Invalid diagnostic record size.');
  if (!fits(record, maxRecordBytes)) throw new Error('Diagnostic summary cannot fit record size.');
  await validateDirectory(filename);
  await withDiagnosticLogLock(filename, () => appendRotatingLog(filename, record + '\n', options.maxBytes));
}

export async function appendTraceSummary(
  filename: string,
  summary: TraceSummary,
  options: TraceLogOptions = {},
): Promise<void> {
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 128) throw new Error('Invalid diagnostic record size.');
  const event = {
    type: 'startup_trace',
    traceSchema: 1,
    runId: String(summary.runId).slice(0, 128),
    command: String(summary.command).slice(0, 64),
    startedAt: String(summary.startedAt).slice(0, 64),
    status: summary.status,
    errorCode: summary.errorCode && /^[A-Z0-9_]{1,64}$/.test(summary.errorCode) ? summary.errorCode : undefined,
    durationMs: summary.durationMs,
    accountedMs: summary.accountedMs,
    unaccountedMs: summary.unaccountedMs,
    stages: summary.stages.map((stage) => ({
      stage: String(stage.stage).slice(0, 128),
      service: stage.service ? String(stage.service).slice(0, 64) : undefined,
      status: stage.status,
      errorCode: stage.errorCode,
      startMs: stage.startMs,
      durationMs: stage.durationMs,
    })),
  };
  let serialized = JSON.stringify(event);
  if (!fits(serialized, maxRecordBytes)) {
    serialized = JSON.stringify({
      type: 'startup_trace',
      traceSchema: 1,
      runId: event.runId,
      command: event.command,
      startedAt: event.startedAt,
      status: event.status,
      durationMs: event.durationMs,
      truncated: true,
    });
  }
  await appendRecord(filename, serialized, { ...options, maxRecordBytes });
}

export async function appendDiagnosticEvent(
  filename: string,
  input: DiagnosticEventInput,
  options: TraceLogOptions = {},
): Promise<void> {
  const maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
  const event = createDiagnosticEvent(input);
  let serialized = JSON.stringify(event);
  if (!fits(serialized, maxRecordBytes)) {
    serialized = JSON.stringify({
      schema: 1,
      type: 'event',
      ts: event.ts,
      level: event.level,
      component: event.component,
      source: event.source,
      message: event.message.slice(0, 160),
      truncated: true,
    });
  }
  await appendRecord(filename, serialized, { ...options, maxRecordBytes });
}

/**
 * Log port used by CLI, Relay, Agent and the Traefik manager process. Writes
 * are serialised across processes; failures degrade diagnostics only.
 */
export class FileDiagnosticLog implements DiagnosticLogPort {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly options: TraceLogOptions = {},
  ) {}

  write(input: DiagnosticEventInput): Promise<void> {
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => appendDiagnosticEvent(this.filename, input, this.options));
    return this.pending;
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }
}
