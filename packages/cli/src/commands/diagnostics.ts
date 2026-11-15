import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from '../config/paths.js';
import { readSettings } from '../config/reader.js';
import { inspectProcess } from '../adapters/process/identity.js';
import { readManagedLog } from '../maintenance/logs.js';
import { FileSnapshotStore, snapshotStateLabel, type DiagnosticSnapshot, type SnapshotReadResult } from 'brc-shared';

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
}

async function snapshotStore(paths: BrcPaths): Promise<FileSnapshotStore> {
  const { settings } = await readSettings(paths, process.env);
  const directory = paths.diagnostics ?? path.join(paths.root, 'diagnostics');
  return new FileSnapshotStore({
    directory,
    staleAfterMs: Math.max(settings.diagnostics.functionSnapshotMs * 3, 60_000),
    isSameProcess: async (snapshot: DiagnosticSnapshot) => {
      if (snapshot.service === 'cli') return snapshot.pid === process.pid;
      let record: { id?: string; pid?: number; createdAt?: string };
      try {
        record = JSON.parse(await readFile(path.join(paths.runtime, `${snapshot.service}.json`), 'utf8'));
      } catch {
        return false;
      }
      if (record.id !== snapshot.instanceId || record.pid !== snapshot.pid || !record.createdAt) return false;
      try {
        const current = await inspectProcess(snapshot.pid);
        return current?.createdAt === record.createdAt;
      } catch {
        return false;
      }
    },
  });
}

export async function readLatestStartup(paths: BrcPaths): Promise<StartupDiagnosticResult> {
  const source = await readManagedLog(paths, 'cli');
  if (!source) return { state: 'missing', summary: null };
  for (const line of source.trimEnd().split(/\r?\n/).reverse()) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const value = event as Record<string, unknown>;
    if (value.type !== 'startup_trace' || value.traceSchema !== 1 || value.command !== 'start') continue;
    if (typeof value.runId !== 'string' || typeof value.durationMs !== 'number' || !Array.isArray(value.stages)) continue;
    return { state: 'recorded', summary: value };
  }
  return { state: 'missing', summary: null };
}

export async function readFunctionDiagnostics(paths: BrcPaths): Promise<FunctionDiagnosticRow[]> {
  const results = await (await snapshotStore(paths)).list();
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

export async function readResourceDiagnostics(paths: BrcPaths): Promise<ResourceDiagnosticRow[]> {
  const results: SnapshotReadResult[] = await (await snapshotStore(paths)).list();
  return results.flatMap((result) => {
    if (!result.snapshot) return [];
    const { snapshot } = result;
    const resources = snapshot.resources;
    return [{
      service: snapshot.service,
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
    }];
  });
}

const MEBIBYTE = 1024 * 1024;

export async function runStartupDiagnostics(
  paths: BrcPaths,
  json: boolean,
  write: (text: string) => void,
): Promise<number> {
  const result = await readLatestStartup(paths);
  if (json) {
    write(JSON.stringify(result));
    return 0;
  }
  if (!result.summary) {
    write('No startup diagnosis has been recorded.');
    return 0;
  }
  const record = result.summary;
  write(`Startup ${record.status}: ${Number(record.durationMs).toFixed(1)} ms (${record.runId})`);
  write(`  Accounted: ${Number(record.accountedMs ?? 0).toFixed(1)} ms · unassigned: ${Number(record.unaccountedMs).toFixed(1)} ms`);
  for (const stage of record.stages as { stage: string; durationMs: number; status: string; service?: string; errorCode?: string }[]) {
    const label = `${stage.stage}${stage.service ? ' / ' + stage.service : ''}`;
    const suffix = stage.errorCode ? ` · ${stage.errorCode}` : '';
    write(`  ${label}: ${stage.durationMs.toFixed(1)} ms (${stage.status}${suffix})`);
  }
  return 0;
}

export async function runFunctionDiagnostics(
  paths: BrcPaths,
  json: boolean,
  write: (text: string) => void,
): Promise<number> {
  const rows = await readFunctionDiagnostics(paths);
  if (json) {
    write(JSON.stringify({ rows }));
    return 0;
  }
  if (rows.length === 0) {
    write('No function statistics are available. Start a managed service with diagnostics enabled.');
    return 0;
  }
  write('Service     Instance           State    Calls   Total ms   Max ms   Kind   Function');
  for (const row of rows.slice(0, 25)) {
    const calls = String(row.calls).padStart(8);
    const total = row.totalMs.toFixed(1).padStart(9);
    const max = row.maxMs.toFixed(1).padStart(8);
    write(`${row.service.padEnd(11)} ${row.instanceId.padEnd(18)} ${row.state.padEnd(8)} ${calls} ${total} ${max}   ${row.kind.padEnd(6)} ${row.name} (${row.file}:${row.line})`);
  }
  const hidden = rows.length - 25;
  if (hidden > 0) write(`  … ${hidden} more entries; use --json for the full list.`);
  write('Async wall time includes awaiting; it is not CPU time.');
  return 0;
}

export async function runResourceDiagnostics(
  paths: BrcPaths,
  json: boolean,
  write: (text: string) => void,
): Promise<number> {
  const rows = await readResourceDiagnostics(paths);
  if (json) {
    write(JSON.stringify({ rows }));
    return 0;
  }
  if (rows.length === 0) {
    write('No resource samples are available. Start a managed service with diagnostics enabled.');
    return 0;
  }
  for (const row of rows) {
    const rss = (row.rssBytes / MEBIBYTE).toFixed(1);
    const peak = row.peakRssBytes === null
      ? 'unavailable'
      : `${(row.peakRssBytes / MEBIBYTE).toFixed(1)} MiB (${row.peakSource}, ${row.peakWindowMs} ms)`;
    const cpu = row.cpuPercent === null ? 'sampling' : `${row.cpuPercent}%`;
    write(`${row.service} · ${row.instanceId} · ${row.state} · captured ${row.capturedAt}`);
    write(`  RSS ${rss} MiB · peak ${peak} · CPU ${cpu} (user ${row.cpuUserMs} ms, system ${row.cpuSystemMs} ms)`);
  }
  return 0;
}
