import type { FunctionTimingSnapshot } from './functions.js';
import type { DiagnosticEvent, DiagnosticEventInput } from './event.js';

export interface DiagnosticLogPort {
  write(input: DiagnosticEventInput): Promise<void>;
  flush(): Promise<void>;
}

export interface ResourcePeak {
  source: 'system' | 'sampled';
  rssBytes: number;
  windowMs: number;
}

export interface ResourceSample {
  schema: 1;
  capturedAt: string;
  source: 'node' | 'native' | 'platform';
  windowMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuPercent: number | null;
  rssBytes: number;
  heapUsedBytes: number | null;
  peak: ResourcePeak | null;
  unavailable?: string;
}

export interface ManagedProcessIdentity {
  pid: number;
  createdAt: string;
  executablePath: string;
  commandLine: string;
}

export interface ManagedProcessResourcePort {
  sample(identity: Readonly<ManagedProcessIdentity>): Promise<ResourceSample>;
}

export interface ResourceSamplePort {
  sample(identity?: Readonly<ManagedProcessIdentity>): Promise<ResourceSample>;
}

export type LegacyResourceSamplePort = ResourceSamplePort;

export type SnapshotState = 'current' | 'exited' | 'stale' | 'missing' | 'corrupt';

export interface DiagnosticSnapshot {
  schema: 1;
  service: 'cli' | 'relay' | 'agent' | 'traefik';
  instanceId: string;
  pid: number;
  capturedAt: string;
  status: 'running' | 'exited';
  functions: FunctionTimingSnapshot;
  resources: ResourceSample;
  partialFailures?: string[];
}

export interface SnapshotReadResult {
  state: SnapshotState;
  snapshot: DiagnosticSnapshot | null;
  reason?: string;
}

export interface DiagnosticSnapshotPort {
  write(snapshot: DiagnosticSnapshot): Promise<void>;
  read(service: DiagnosticSnapshot['service'], instanceId: string): Promise<SnapshotReadResult>;
  list(service?: DiagnosticSnapshot['service']): Promise<SnapshotReadResult[]>;
  prune(retentionMs: number, isActive: (snapshot: DiagnosticSnapshot) => boolean): Promise<number>;
}

export type TraceStatus = 'ok' | 'failed' | 'cancelled';

export interface TraceSpan {
  readonly stage: string;
  end(status?: TraceStatus, errorCode?: string): void;
}

export interface TraceSink {
  begin(stage: string, service?: string): TraceSpan;
  span<T>(stage: string, operation: () => Promise<T>, service?: string): Promise<T>;
}

export type { DiagnosticEvent };
