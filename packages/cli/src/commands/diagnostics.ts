import { lstat, readFile } from 'node:fs/promises';
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
  unavailable: string | null;
}

async function snapshotStore(paths: BrcPaths): Promise<FileSnapshotStore> {
  const { settings } = await readSettings(paths, process.env);
  const directory = paths.diagnostics ?? path.join(paths.root, 'diagnostics');
  return new FileSnapshotStore({
    directory,
    staleAfterMs: Math.max(settings.diagnostics.functionSnapshotMs * 3, 60_000),
    isSameProcess: async (snapshot: DiagnosticSnapshot) => {
      if (snapshot.service === 'cli') return snapshot.pid === process.pid;
      if (snapshot.service === 'traefik' && snapshot.instanceId.endsWith('-binary')) {
        try {
          const filename = path.join(paths.runtime, 'traefik-child.json');
          const info = await lstat(filename);
          if (!info.isFile() || info.isSymbolicLink()) return false;
          const record = JSON.parse(await readFile(filename, 'utf8')) as {
            instanceId?: string; pid?: number; createdAt?: string; executablePath?: string; commandLine?: string;
          };
          if (record.instanceId !== snapshot.instanceId || record.pid !== snapshot.pid
            || !record.createdAt || !record.executablePath || !record.commandLine) return false;
          const current = await inspectProcess(snapshot.pid);
          return current?.createdAt === record.createdAt
            && current.executablePath === record.executablePath
            && current.commandLine === record.commandLine;
        } catch {
          return false;
        }
      }
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
