import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FunctionTiming, installFunctionProbe, type FunctionDescriptor } from './core/functions.js';
import { FileDiagnosticLog } from './adapters/logging.js';
import { NodeResourceSampler } from './adapters/resources-node.js';
import { FileSnapshotStore } from './adapters/snapshots.js';
import { DiagnosticSession } from './core/session.js';
import type { DiagnosticComponent, DiagnosticLevel } from './core/event.js';

export interface DiagnosticsRuntimeOptions {
  component: DiagnosticComponent;
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
  manifestUrl?: URL;
  logFile?: string;
  snapshotDirectory?: string;
}

export interface DiagnosticsLogOptions {
  level?: DiagnosticLevel;
  source?: { file: string; function?: string };
  errorCode?: string;
  error?: unknown;
  data?: Record<string, unknown>;
}

export interface DiagnosticsRuntime {
  enabled: boolean;
  functions?: FunctionTiming;
  log(message: string, options?: DiagnosticsLogOptions): void;
  captureSnapshot(status?: 'running' | 'exited'): Promise<void>;
  stop(): Promise<void>;
}

interface ResolvedDiagnosticsSettings {
  enabled: boolean;
  resourceSampleMs: number;
  functionSnapshotMs: number;
  maxRecordBytes: number;
  retentionDays: number;
  directory?: string;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function resolveDiagnosticsSettings(env: NodeJS.ProcessEnv = process.env): ResolvedDiagnosticsSettings {
  const enabled = env.BRC_DIAGNOSTICS_ENABLED === undefined
    ? false
    : /^(true|1)$/i.test(env.BRC_DIAGNOSTICS_ENABLED);
  return {
    enabled,
    resourceSampleMs: integer(env.BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS, 1_000, 100, 60_000),
    functionSnapshotMs: integer(env.BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS, 10_000, 1_000, 3_600_000),
    maxRecordBytes: integer(env.BRC_DIAGNOSTICS_MAX_RECORD_BYTES, 65_536, 256, 65_536),
    retentionDays: integer(env.BRC_DIAGNOSTICS_RETENTION_DAYS, 7, 0, 365),
    directory: env.BRC_DIAGNOSTICS_DIR,
  };
}

type ManifestEntry = FunctionDescriptor & { id: string };

async function loadManifest(url: URL | undefined): Promise<ManifestEntry[]> {
  if (!url) return [];
  try {
    const manifest = JSON.parse(await readFile(url, 'utf8')) as { functions?: unknown };
    if (!Array.isArray(manifest.functions)) return [];
    return manifest.functions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.name !== 'string') return [];
      return [{
        id: item.id,
        name: item.name,
        file: typeof item.file === 'string' ? item.file : '',
        line: typeof item.line === 'number' ? item.line : 0,
        kind: item.kind === 'async' ? 'async' as const : 'sync' as const,
      }];
    });
  } catch {
    return [];
  }
}

const NOOP_RUNTIME: DiagnosticsRuntime = {
  enabled: false,
  log: () => undefined,
  captureSnapshot: async () => undefined,
  stop: async () => undefined,
};

/**
 * Creates the diagnostics objects for one process, connects the probes and
 * starts continuous resource sampling plus periodic snapshots. Any missing
 * configuration degrades to a no-op runtime so business results never depend
 * on diagnostics.
 */
export async function startDiagnostics(options: DiagnosticsRuntimeOptions): Promise<DiagnosticsRuntime> {
  const env = options.env ?? process.env;
  const settings = resolveDiagnosticsSettings(env);
  const directory = options.snapshotDirectory ?? settings.directory;
  if (!settings.enabled || !directory) return NOOP_RUNTIME;

  const functions = new FunctionTiming();
  const manifests = [new URL('../diagnostics-manifest.json', import.meta.url)];
  if (options.manifestUrl) manifests.push(options.manifestUrl);
  for (const manifest of manifests) {
    for (const descriptor of await loadManifest(manifest)) {
      functions.register(descriptor.id, descriptor);
    }
  }
  installFunctionProbe(functions);
  const resources = new NodeResourceSampler({ intervalMs: settings.resourceSampleMs });
  resources.start();
  const store = new FileSnapshotStore({
    directory,
    staleAfterMs: Math.max(settings.functionSnapshotMs * 3, 60_000),
  });
  const session = new DiagnosticSession({
    service: options.component === 'native' ? 'cli' : options.component,
    instanceId: options.instanceId ?? `${options.component}-${process.pid}`,
    store,
    functions,
    resources,
    snapshotIntervalMs: settings.functionSnapshotMs,
  });
  session.start();
  const log = options.logFile
    ? new FileDiagnosticLog(options.logFile, { maxRecordBytes: settings.maxRecordBytes })
    : undefined;

  return {
    enabled: true,
    functions,
    log(message, logOptions = {}) {
      void log?.write({
        level: logOptions.level ?? 'info',
        component: options.component,
        source: logOptions.source ?? { file: path.basename(process.argv[1] ?? 'unknown') },
        message,
        instanceId: options.instanceId ?? `${options.component}-${process.pid}`,
        ...(logOptions.errorCode ? { errorCode: logOptions.errorCode } : {}),
        ...(logOptions.error ? { stack: errorText(logOptions.error) } : {}),
        ...(logOptions.data ? { data: logOptions.data } : {}),
      }).catch(() => undefined);
    },
    captureSnapshot: async (status = 'running') => { await session.capture(status); },
    stop: async () => {
      resources.stop();
      await session.stop();
      await log?.flush();
    },
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
