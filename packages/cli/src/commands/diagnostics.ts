import type { BrcPaths } from '../config/paths.js';
import { readManagedLog } from '../adapters/storage/logs.js';
import {
  snapshotStateLabel,
  type DiagnosticEvent,
  type DiagnosticQueryFilter,
  type DiagnosticSnapshotPort,
  type SnapshotReadResult,
} from 'brc-shared';

interface SharedQueryModule {
  SqliteDiagnosticQuery: new (options: { databasePath: string }) => {
    query(filter: DiagnosticQueryFilter): Promise<DiagnosticEvent[]>;
    close(): void;
  };
  resolveDiagnosticsDbPath(directory: string, env?: NodeJS.ProcessEnv): string;
}

let sharedQueryModule: Promise<SharedQueryModule> | undefined;

function loadSharedQueryModule(): Promise<SharedQueryModule> {
  sharedQueryModule ??= (async () => {
    let module = await import('brc-shared') as unknown as SharedQueryModule;
    if (typeof module.SqliteDiagnosticQuery !== 'function' || typeof module.resolveDiagnosticsDbPath !== 'function') {
      module = await import(new URL('../../../shared/dist/index.js', import.meta.url).href) as unknown as SharedQueryModule;
    }
    return module;
  })();
  return sharedQueryModule;
}

export interface StartupDiagnosticResult {
  state: 'missing' | 'recorded';
  summary: Record<string, unknown> | null;
}

export interface FunctionDiagnosticRow {
  service: string;
  instanceId: string;
  state: string;
  capturedAt: string | null;
  calls: number;
  totalMs: number;
  maxMs: number;
  name: string;
  file: string;
  line: number;
  kind: string;
  asyncWallMs: number;
  errors: number;
}

export interface ResourceDiagnosticRow {
  service: string;
  instanceId: string;
  state: string;
  capturedAt: string | null;
  cpuPercent: number | null;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
  heapUsedBytes: number | null;
  peakSource: string | null;
  peakRssBytes: number | null;
  peakWindowMs: number | null;
  unavailable: string | null;
}


export async function readDiagnosticLogs(paths: BrcPaths, filter: DiagnosticQueryFilter): Promise<DiagnosticEvent[]> {
  const shared = await loadSharedQueryModule();
  const query = new shared.SqliteDiagnosticQuery({ databasePath: shared.resolveDiagnosticsDbPath(paths.data, process.env) });
  try {
    return await query.query(filter);
  } finally {
    query.close();
  }
}

async function readLatestTrace(paths: BrcPaths, acceptedCommands: readonly string[]): Promise<StartupDiagnosticResult> {
  const source = await readManagedLog(paths, 'cli');
  if (!source) return { state: 'missing', summary: null };
  for (const line of source.trimEnd().split(/\r?\n/).reverse()) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const value = event as Record<string, unknown>;
    if (value.type !== 'startup_trace' || value.traceSchema !== 1 || !acceptedCommands.includes(String(value.command))) continue;
    if (typeof value.runId !== 'string' || typeof value.durationMs !== 'number' || !Array.isArray(value.stages)) continue;
    return { state: 'recorded', summary: value };
  }
  return { state: 'missing', summary: null };
}

export function readLatestStartup(paths: BrcPaths): Promise<StartupDiagnosticResult> {
  return readLatestTrace(paths, ['start']);
}

export function readLatestLifecycle(paths: BrcPaths): Promise<StartupDiagnosticResult> {
  return readLatestTrace(paths, ['start', 'stop', 'restart']);
}

export async function readFunctionDiagnostics(store: Pick<DiagnosticSnapshotPort, 'list'>): Promise<FunctionDiagnosticRow[]> {
  const results = await store.list();
  const rows: FunctionDiagnosticRow[] = [];
  for (const result of results) {
    if (!result.snapshot) continue;
    const { snapshot } = result;
    for (const entry of snapshot.functions.entries) {
      rows.push({
        service: snapshot.service,
        instanceId: snapshot.instanceId,
        state: snapshotStateLabel(result.state),
        capturedAt: snapshot.capturedAt,
        calls: entry.calls,
        totalMs: entry.totalMs,
        maxMs: entry.maxMs,
        name: entry.name,
        file: entry.file,
        line: entry.line,
        kind: entry.kind,
        asyncWallMs: entry.asyncWallMs,
        errors: entry.errors,
      });
    }
  }
  return rows.sort((left, right) => right.totalMs - left.totalMs);
}

export async function readResourceDiagnostics(store: Pick<DiagnosticSnapshotPort, 'list'>): Promise<ResourceDiagnosticRow[]> {
  const results: SnapshotReadResult[] = await store.list();
  return results.flatMap((result) => {
    if (!result.snapshot) return [];
    const { snapshot } = result;
    const resources = snapshot.resources;
    return [{
      service: snapshot.service === 'traefik' && snapshot.instanceId.endsWith('-binary') ? 'traefik-binary' : snapshot.service,
      instanceId: snapshot.instanceId,
      state: snapshotStateLabel(result.state),
      capturedAt: snapshot.capturedAt,
      cpuPercent: resources.cpuPercent,
      cpuUserMs: resources.cpuUserMs,
      cpuSystemMs: resources.cpuSystemMs,
      rssBytes: resources.rssBytes,
      heapUsedBytes: resources.heapUsedBytes,
      peakSource: resources.peak?.source ?? null,
      peakRssBytes: resources.peak?.rssBytes ?? null,
      peakWindowMs: resources.peak?.windowMs ?? null,
      unavailable: resources.unavailable ?? null,
    }];
  });
}
