import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DiagnosticSnapshot,
  DiagnosticSnapshotPort,
  FunctionTimingSnapshot,
  ResourceSample,
} from 'brc-shared';
import { NATIVE_PROCESS_BINARY, type ProcessIdentity } from './identity.js';

const execFile = promisify(execFileCallback);
const EMPTY_FUNCTIONS: FunctionTimingSnapshot = {
  schema: 1,
  totalCalls: 0,
  entries: [],
  truncated: false,
  droppedIds: 0,
};

export interface RawProcessSample {
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number | null;
  rssBytes: number;
  systemPeakBytes: number | null;
}

export interface ManagedProcessResourceSamplerOptions {
  identity: ProcessIdentity;
  instanceId: string;
  runtimeDirectory: string;
  intervalMs: number;
  snapshots: DiagnosticSnapshotPort;
  onError?: (error: unknown) => void;
  sample?: (pid: number) => Promise<RawProcessSample>;
}

export interface NativeRunResult {
  stdout: string;
}

export interface NativeProcessSampleOptions {
  executablePath?: string;
  run?: (command: string, args: readonly string[]) => Promise<NativeRunResult>;
}

function sampleNumber(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Native process sample field ${key} is invalid.`);
  }
  return value;
}

function sampleNullableNumber(value: unknown, key: string): number | null {
  if (value === null || value === undefined) return null;
  return sampleNumber(value, key);
}

export function parseNativeSamplePayload(payload: unknown, pid: number): RawProcessSample {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !('samples' in payload) || !Array.isArray((payload as { samples: unknown }).samples)) {
    throw new Error('Native sample payload has no samples array.');
  }
  const rows = (payload as { samples: unknown[] }).samples;
  const row = rows.find((item) => item && typeof item === 'object' && !Array.isArray(item)
    && 'pid' in item && item.pid === pid) ?? rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) || !('status' in row)) {
    throw new Error('Native sample payload has no matching process row.');
  }
  const value = row as Record<string, unknown>;
  if (value.status !== 'found') {
    const reason = typeof value.unavailable === 'string' && value.unavailable
      ? value.unavailable
      : typeof value.code === 'string' && value.code ? value.code : `Native sample status ${String(value.status)}.`;
    throw new Error(reason);
  }
  return {
    cpuUserMs: sampleNumber(value.cpuUserMs, 'cpuUserMs'),
    cpuSystemMs: sampleNumber(value.cpuSystemMs, 'cpuSystemMs'),
    cpuPercent: sampleNullableNumber(value.cpuPercent, 'cpuPercent'),
    rssBytes: sampleNumber(value.rssBytes, 'rssBytes'),
    systemPeakBytes: sampleNullableNumber(value.systemPeakBytes, 'systemPeakBytes'),
  };
}

export function createNativeProcessSample(options: NativeProcessSampleOptions = {}): (pid: number) => Promise<RawProcessSample> {
  const executablePath = options.executablePath ?? NATIVE_PROCESS_BINARY;
  const run = options.run ?? ((command: string, args: readonly string[]) => execFile(command, [...args], {
    encoding: 'utf8', timeout: 2_000, windowsHide: true, maxBuffer: 8_192,
  }));
  return async (pid: number): Promise<RawProcessSample> => {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Native sampler requires a valid PID.');
    const { stdout } = await run(executablePath, ['sample', String(pid)]);
    let payload: unknown;
    try { payload = JSON.parse(stdout) as unknown; }
    catch { throw new Error('Native sample returned malformed JSON.'); }
    return parseNativeSamplePayload(payload, pid);
  };
}

function unavailableSample(windowMs: number, reason: string): ResourceSample {
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    source: 'platform',
    windowMs,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    cpuPercent: null,
    rssBytes: 0,
    heapUsedBytes: null,
    peak: null,
    unavailable: reason,
  };
}

export class ManagedProcessResourceSampler {
  private readonly identity: ProcessIdentity;
  private readonly instanceId: string;
  private readonly recordFile: string;
  private readonly intervalMs: number;
  private readonly snapshots: DiagnosticSnapshotPort;
  private readonly onError?: (error: unknown) => void;
  private readonly sample: (pid: number) => Promise<RawProcessSample>;
  private readonly startedAt = performance.now();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private lastSample = unavailableSample(0, 'SAMPLE_NOT_CAPTURED');
  private lastCpuMs?: number;
  private lastSampleAt?: number;
  private peakRssBytes = 0;

  constructor(options: ManagedProcessResourceSamplerOptions) {
    if (!Number.isSafeInteger(options.identity.pid) || options.identity.pid <= 0) {
      throw new Error('Managed process resource sampler requires a valid PID.');
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(options.instanceId)) {
      throw new Error('Managed process resource instance ID is invalid.');
    }
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 60_000) {
      throw new Error('Managed process resource interval must be between 100 and 60000 ms.');
    }
    if (!path.isAbsolute(options.runtimeDirectory)) throw new Error('Managed process runtime directory must be absolute.');
    this.identity = options.identity;
    this.instanceId = options.instanceId;
    this.recordFile = path.join(options.runtimeDirectory, 'traefik-child.json');
    this.intervalMs = options.intervalMs;
    this.snapshots = options.snapshots;
    this.onError = options.onError;
    this.sample = options.sample ?? createNativeProcessSample();
  }

  async start(): Promise<void> {
    await this.writeIdentityRecord();
    try {
      await this.capture('running');
    } catch (error) {
      await this.removeIdentityRecord();
      throw error;
    }
    this.timer = setInterval(() => {
      void this.capture('running').catch((error: unknown) => this.onError?.(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch((error: unknown) => this.onError?.(error));
    await this.capture('exited').catch((error: unknown) => this.onError?.(error));
    await this.removeIdentityRecord();
  }

  private capture(status: 'running' | 'exited'): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operation = this.writeSnapshot(status);
    this.inFlight = operation;
    return operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
  }

  private async writeSnapshot(status: 'running' | 'exited'): Promise<void> {
    const now = performance.now();
    const windowMs = Math.max(0, Math.round(now - this.startedAt));
    if (status === 'running') {
      try {
        const sample = await this.sample(this.identity.pid);
        const totalCpuMs = sample.cpuUserMs + sample.cpuSystemMs;
        const elapsedMs = this.lastSampleAt === undefined ? 0 : now - this.lastSampleAt;
        const cpuDelta = this.lastCpuMs === undefined ? 0 : totalCpuMs - this.lastCpuMs;
        const cpuPercent = sample.cpuPercent ?? (elapsedMs > 0 ? Math.max(0, cpuDelta / elapsedMs * 100) : null);
        this.lastCpuMs = totalCpuMs;
        this.lastSampleAt = now;
        this.peakRssBytes = Math.max(this.peakRssBytes, sample.rssBytes);
        const peakBytes = sample.systemPeakBytes ?? this.peakRssBytes;
        this.lastSample = {
          schema: 1,
          capturedAt: new Date().toISOString(),
          source: 'platform',
          windowMs,
          cpuUserMs: Math.round(sample.cpuUserMs),
          cpuSystemMs: Math.round(sample.cpuSystemMs),
          cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
          rssBytes: sample.rssBytes,
          heapUsedBytes: null,
          peak: {
            source: sample.systemPeakBytes === null ? 'sampled' : 'system',
            rssBytes: peakBytes,
            windowMs,
          },
        };
      } catch (error) {
        this.lastSample = unavailableSample(windowMs, error instanceof Error ? error.message : 'PROCESS_SAMPLE_FAILED');
      }
    } else {
      this.lastSample = { ...this.lastSample, capturedAt: new Date().toISOString(), windowMs };
    }
    const snapshot: DiagnosticSnapshot = {
      schema: 1,
      service: 'traefik',
      instanceId: this.instanceId,
      pid: this.identity.pid,
      capturedAt: this.lastSample.capturedAt,
      status,
      functions: EMPTY_FUNCTIONS,
      resources: this.lastSample,
    };
    await this.snapshots.write(snapshot);
  }

  private async writeIdentityRecord(): Promise<void> {
    const directory = path.dirname(this.recordFile);
    await mkdir(directory, { recursive: true });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('Traefik child identity directory must be a plain directory.');
    }
    const record = {
      schema: 1,
      instanceId: this.instanceId,
      pid: this.identity.pid,
      createdAt: this.identity.createdAt,
      executablePath: this.identity.executablePath,
      commandLine: this.identity.commandLine,
    };
    const temporary = `${this.recordFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.recordFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async removeIdentityRecord(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.recordFile, 'utf8')) as { instanceId?: string };
      if (value.instanceId === this.instanceId) await rm(this.recordFile, { force: true });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        this.onError?.(error);
      }
    }
  }
}
