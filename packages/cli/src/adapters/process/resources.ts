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
import type { ProcessIdentity } from './identity.js';

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

let clockTicksPerSecond: Promise<number> | undefined;

async function linuxClockTicks(): Promise<number> {
  clockTicksPerSecond ??= execFile('getconf', ['CLK_TCK'], { encoding: 'utf8', windowsHide: true })
    .then(({ stdout }) => Number.parseInt(stdout.trim(), 10))
    .then((value) => {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Linux clock tick frequency is unavailable.');
      return value;
    });
  return clockTicksPerSecond;
}

function parseCpuTime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error('Process CPU time is malformed.');
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

async function sampleWindows(pid: number): Promise<RawProcessSample> {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{ userMs = [double]$p.UserProcessorTime.TotalMilliseconds; systemMs = [double]$p.PrivilegedProcessorTime.TotalMilliseconds; rssBytes = [long]$p.WorkingSet64; peakBytes = [long]$p.PeakWorkingSet64 } | ConvertTo-Json -Compress`;
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    maxBuffer: 8_192,
  });
  const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const number = (key: string): number => {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error(`Windows process resource field ${key} is invalid.`);
    return item;
  };
  return {
    cpuUserMs: number('userMs'),
    cpuSystemMs: number('systemMs'),
    cpuPercent: null,
    rssBytes: number('rssBytes'),
    systemPeakBytes: number('peakBytes'),
  };
}

async function sampleLinux(pid: number): Promise<RawProcessSample> {
  const [stat, status, ticksPerSecond] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/status`, 'utf8'),
    linuxClockTicks(),
  ]);
  const endOfCommand = stat.lastIndexOf(')');
  if (endOfCommand < 0) throw new Error('Linux process stat is malformed.');
  const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (!Number.isSafeInteger(userTicks) || !Number.isSafeInteger(systemTicks)) throw new Error('Linux process CPU counters are invalid.');
  const current = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  const peak = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  if (!current) throw new Error('Linux process RSS is unavailable.');
  return {
    cpuUserMs: userTicks * 1000 / ticksPerSecond,
    cpuSystemMs: systemTicks * 1000 / ticksPerSecond,
    cpuPercent: null,
    rssBytes: Number(current[1]) * 1024,
    systemPeakBytes: peak ? Number(peak[1]) * 1024 : null,
  };
}

async function sampleDarwin(pid: number): Promise<RawProcessSample> {
  const { stdout } = await execFile('ps', ['-p', String(pid), '-o', '%cpu=,rss=,time='], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    maxBuffer: 8_192,
  });
  const [cpuText, rssText, timeText] = stdout.trim().split(/\s+/);
  const cpuPercent = Number(cpuText);
  const rssKiB = Number(rssText);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(rssKiB) || rssKiB < 0 || !timeText) {
    throw new Error('macOS process resource sample is incomplete.');
  }
  return {
    cpuUserMs: parseCpuTime(timeText),
    cpuSystemMs: 0,
    cpuPercent: null,
    rssBytes: rssKiB * 1024,
    systemPeakBytes: null,
  };
}

async function sampleProcess(pid: number): Promise<RawProcessSample> {
  if (process.platform === 'win32') return sampleWindows(pid);
  if (process.platform === 'linux') return sampleLinux(pid);
  if (process.platform === 'darwin') return sampleDarwin(pid);
  throw new Error(`Process resource sampling is unsupported on ${process.platform}.`);
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
    this.sample = options.sample ?? sampleProcess;
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
