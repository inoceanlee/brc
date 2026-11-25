import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, type BrcSettings } from '../../config/core/settings.js';
import type { ToolHistoryEntry, ToolHistoryQuery, ToolHistoryStorePort } from '../../contracts/ports.js';
import { createDiagnosticEvent, type DiagnosticEvent, type DiagnosticEventInput } from '../core/event.js';
import type { FunctionTimingSnapshot } from '../core/functions.js';
import type {
  DiagnosticLogPort,
  DiagnosticQueryFilter,
  DiagnosticQueryPort,
  DiagnosticSnapshot,
  DiagnosticSnapshotPort,
  RelayAuditEntry,
  RelayAuditPort,
  SnapshotReadResult,
  SnapshotState,
} from '../core/ports.js';
import type { TraceSummary } from '../core/recorder.js';

export const DIAGNOSTICS_DB_FILENAME = 'brc-diagnostics.sqlite';
export const DIAGNOSTICS_DB_ENV_KEY = 'BRC_DIAGNOSTICS_DB';

export function resolveDiagnosticsDbPath(
  dataDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[DIAGNOSTICS_DB_ENV_KEY];
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(path.resolve(dataDirectory), DIAGNOSTICS_DB_FILENAME);
}

export interface DiagnosticsRetentionConfig {
  eventsRetentionDays: number;
  functionsRetentionDays: number;
  tracesRetentionDays: number;
  snapshotsRetentionDays: number;
  historyRetentionDays: number;
  auditRetentionDays: number;
  auditMaxEntries: number;
  historyMaxEntries: number;
  maxDatabaseMiB: number;
  maxRecordBytes: number;
}

export function diagnosticsRetentionConfig(
  settings: Readonly<BrcSettings> = DEFAULT_SETTINGS,
): DiagnosticsRetentionConfig {
  return {
    eventsRetentionDays: settings.diagnostics.retentionDays,
    functionsRetentionDays: settings.diagnostics.retentionDays,
    tracesRetentionDays: settings.diagnostics.retentionDays,
    snapshotsRetentionDays: settings.diagnostics.retentionDays,
    historyRetentionDays: settings.diagnostics.retentionDays,
    auditRetentionDays: settings.audit.retentionDays,
    auditMaxEntries: settings.audit.maxEntries,
    historyMaxEntries: settings.audit.maxEntries,
    maxDatabaseMiB: settings.logs.maxTotalMiB,
    maxRecordBytes: settings.diagnostics.maxRecordBytes,
  };
}

type SqlParam = string | number | null | Uint8Array;

export const RELAY_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  epoch_ms INTEGER NOT NULL,
  user_id TEXT,
  device_id TEXT,
  client TEXT,
  tool TEXT NOT NULL,
  args_hash TEXT,
  ok INTEGER NOT NULL,
  ms INTEGER,
  error TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_epoch ON relay_audit(epoch_ms);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON relay_audit(tool);
`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 30000;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  level TEXT NOT NULL,
  component TEXT NOT NULL,
  run_id TEXT,
  instance_id TEXT,
  source_file TEXT NOT NULL,
  source_function TEXT,
  error_code TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_epoch ON diagnostic_events(epoch_ms);
CREATE INDEX IF NOT EXISTS idx_events_run ON diagnostic_events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_level ON diagnostic_events(level);
CREATE INDEX IF NOT EXISTS idx_events_source ON diagnostic_events(source_file, source_function);
CREATE TABLE IF NOT EXISTS function_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  function_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  async_wall_ms REAL NOT NULL,
  errors INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_functions_epoch ON function_stats(epoch_ms);
CREATE TABLE IF NOT EXISTS trace_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  stage TEXT NOT NULL,
  service TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  start_ms REAL NOT NULL,
  duration_ms REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_epoch ON trace_stages(epoch_ms);
CREATE INDEX IF NOT EXISTS idx_traces_run ON trace_stages(run_id);
CREATE TABLE IF NOT EXISTS trace_runs (
  run_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_runs_epoch ON trace_runs(epoch_ms);
CREATE TABLE IF NOT EXISTS snapshots (
  service TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (service, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_epoch ON snapshots(epoch_ms);
CREATE TABLE IF NOT EXISTS tool_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  epoch_ms INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  duration_ms REAL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_epoch ON tool_history(epoch_ms);
${RELAY_AUDIT_SCHEMA}`;

export class DiagnosticDatabase {
  private closed = false;

  constructor(
    readonly connection: DatabaseSync,
    readonly path: string,
    readonly config: DiagnosticsRetentionConfig,
  ) {}

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  count(table: string): number {
    const row = this.connection.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    return row.total;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}

function databaseSize(filename: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += statSync(`${filename}${suffix}`).size; } catch { }
  }
  return total;
}

export function openReadOnlyDatabase(filename: string): DatabaseSync {
  return new DatabaseSync(filename, { readOnly: true });
}

export function openDiagnosticDatabase(
  databasePath: string,
  config: DiagnosticsRetentionConfig = diagnosticsRetentionConfig(),
): DiagnosticDatabase {
  const resolved = path.resolve(databasePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const connection = new DatabaseSync(resolved);
  connection.exec('PRAGMA busy_timeout = 30000;');
  connection.exec(SCHEMA);
  return new DiagnosticDatabase(connection, resolved, config);
}

export interface SqliteAdapterOptions {
  database?: DiagnosticDatabase;
  databasePath?: string;
  config?: DiagnosticsRetentionConfig;
}

function resolveDatabase(options: SqliteAdapterOptions): { database: DiagnosticDatabase; ownsDatabase: boolean } {
  if (options.database) return { database: options.database, ownsDatabase: false };
  if (!options.databasePath) throw new Error('A database handle or databasePath is required.');
  return {
    database: openDiagnosticDatabase(options.databasePath, options.config ?? diagnosticsRetentionConfig()),
    ownsDatabase: true,
  };
}

function optional(value: string | undefined): SqlParam {
  return value === undefined ? null : value;
}

function numeric(value: number | null | undefined): SqlParam {
  return value === undefined || value === null || !Number.isFinite(value) ? null : value;
}

function boundedPayload(event: DiagnosticEvent, maxBytes: number): string {
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) <= maxBytes) return payload;
  const reduced = {
    schema: 1,
    type: 'event',
    ts: event.ts,
    level: event.level,
    component: event.component,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.instanceId ? { instanceId: event.instanceId } : {}),
    source: event.source,
    message: event.message.slice(0, 160),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    truncated: true,
  } as DiagnosticEvent;
  return JSON.stringify(reduced);
}

export class SqliteDiagnosticLog implements DiagnosticLogPort {
  private readonly database: DiagnosticDatabase;
  private readonly ownsDatabase: boolean;
  private readonly config: DiagnosticsRetentionConfig;

  constructor(options: SqliteAdapterOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.ownsDatabase = resolved.ownsDatabase;
    this.config = options.config ?? this.database.config;
  }

  static open(options: SqliteAdapterOptions = {}): SqliteDiagnosticLog {
    return new SqliteDiagnosticLog(options);
  }

  write(input: DiagnosticEventInput): Promise<void> {
    const event = createDiagnosticEvent(input);
    const epoch = Date.parse(event.ts);
    const payload = boundedPayload(event, this.config.maxRecordBytes);
    this.database.transaction(() => {
      this.database.connection.prepare(
        'INSERT INTO diagnostic_events (ts,epoch_ms,level,component,run_id,instance_id,source_file,source_function,error_code,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        event.ts, Number.isFinite(epoch) ? epoch : 0, event.level, event.component,
        optional(event.runId), optional(event.instanceId), event.source.file,
        optional(event.source.function), optional(event.errorCode), payload,
      );
    });
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    return undefined;
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

export class SqliteDiagnosticQuery implements DiagnosticQueryPort {
  private readonly database: DiagnosticDatabase;
  private readonly ownsDatabase: boolean;

  constructor(options: SqliteAdapterOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.ownsDatabase = resolved.ownsDatabase;
  }

  query(filter: DiagnosticQueryFilter = {}): Promise<DiagnosticEvent[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    const since = filter.since === undefined ? Number.NaN : Date.parse(filter.since);
    const until = filter.until === undefined ? Number.NaN : Date.parse(filter.until);
    if (Number.isFinite(since)) {
      clauses.push('epoch_ms >= ?');
      params.push(since);
    }
    if (Number.isFinite(until)) {
      clauses.push('epoch_ms <= ?');
      params.push(until);
    }
    if (filter.source !== undefined) {
      clauses.push('(source_file = ? OR source_function = ?)');
      params.push(filter.source, filter.source);
    }
    if (filter.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.level !== undefined) {
      clauses.push('level = ?');
      params.push(filter.level);
    }
    if (filter.component !== undefined) {
      clauses.push('component = ?');
      params.push(filter.component);
    }
    const limit = Number.isSafeInteger(filter.limit) && (filter.limit ?? 0) > 0 ? filter.limit as number : 1_000;
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.connection.prepare(
      `SELECT payload FROM diagnostic_events${where} ORDER BY epoch_ms ASC, id ASC LIMIT ?`,
    ).all(...params, limit) as Array<{ payload: string }>;
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as DiagnosticEvent));
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

const SERVICE_PATTERN = /^(cli|relay|agent|traefik)$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH';
  }
}

export interface SqliteSnapshotStoreOptions extends SqliteAdapterOptions {
  staleAfterMs?: number;
  isAlive?: (pid: number) => boolean;
  isSameProcess?: (snapshot: DiagnosticSnapshot) => Promise<boolean>;
  now?: () => Date;
}

export class SqliteSnapshotStore implements DiagnosticSnapshotPort {
  private readonly database: DiagnosticDatabase;
  private readonly ownsDatabase: boolean;
  private readonly staleAfterMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly isSameProcess?: (snapshot: DiagnosticSnapshot) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly writtenFailures = new Set<string>();
  private static readonly MAX_WRITTEN_FAILURES = 5_000;

  constructor(options: SqliteSnapshotStoreOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.ownsDatabase = resolved.ownsDatabase;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.isSameProcess = options.isSameProcess;
    this.now = options.now ?? (() => new Date());
  }

  static open(options: SqliteSnapshotStoreOptions = {}): SqliteSnapshotStore {
    return new SqliteSnapshotStore(options);
  }

  write(snapshot: DiagnosticSnapshot): Promise<void> {
    if (!SERVICE_PATTERN.test(snapshot.service)) throw new Error(`Unknown diagnostic snapshot service: ${snapshot.service}`);
    if (!INSTANCE_PATTERN.test(snapshot.instanceId)) throw new Error('Diagnostic snapshot instance id is not safe.');
    const captured = Date.parse(snapshot.capturedAt);
    const committedKeys: string[] = [];
    this.database.transaction(() => {
      this.database.connection.prepare(
        'INSERT INTO snapshots (service,instance_id,pid,captured_at,epoch_ms,status,payload) VALUES (?,?,?,?,?,?,?) '
        + 'ON CONFLICT(service,instance_id) DO UPDATE SET pid=excluded.pid,captured_at=excluded.captured_at,'
        + 'epoch_ms=excluded.epoch_ms,status=excluded.status,payload=excluded.payload',
      ).run(
        snapshot.service, snapshot.instanceId, snapshot.pid, snapshot.capturedAt,
        Number.isFinite(captured) ? captured : 0, snapshot.status, JSON.stringify(snapshot),
      );
      const insertFunction = this.database.connection.prepare(
        'INSERT INTO function_stats (captured_at,epoch_ms,service,instance_id,function_id,name,file,line,kind,calls,total_ms,max_ms,async_wall_ms,errors) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const entry of snapshot.functions.entries) {
        insertFunction.run(
          snapshot.capturedAt, Number.isFinite(captured) ? captured : 0, snapshot.service,
          snapshot.instanceId, entry.id, entry.name, entry.file, entry.line, entry.kind,
          entry.calls, entry.totalMs, entry.maxMs, entry.asyncWallMs, entry.errors,
        );
      }
      const insertEvent = this.database.connection.prepare(
        'INSERT INTO diagnostic_events (ts,epoch_ms,level,component,run_id,instance_id,source_file,source_function,error_code,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      for (const failure of snapshot.functions.failures ?? []) {
        const key = `${snapshot.instanceId}:${failure.id}:${failure.message}`;
        if (this.writtenFailures.has(key) || committedKeys.includes(key)) continue;
        const event = createDiagnosticEvent({
          level: 'error',
          component: snapshot.service,
          instanceId: snapshot.instanceId,
          source: { file: snapshot.service, function: failure.id },
          message: failure.message,
          errorCode: 'FUNCTION_ERROR',
          stack: failure.stack,
          now: new Date(snapshot.capturedAt),
        });
        insertEvent.run(
          event.ts, Number.isFinite(captured) ? captured : 0, event.level, event.component,
          optional(event.runId), optional(event.instanceId), event.source.file,
          optional(event.source.function), optional(event.errorCode), boundedPayload(event, this.database.config.maxRecordBytes),
        );
        committedKeys.push(key);
      }
    });
    for (const key of committedKeys) this.writtenFailures.add(key);
    if (this.writtenFailures.size > SqliteSnapshotStore.MAX_WRITTEN_FAILURES) {
      const excess = this.writtenFailures.size - SqliteSnapshotStore.MAX_WRITTEN_FAILURES;
      const iterator = this.writtenFailures.values();
      for (let index = 0; index < excess; index += 1) {
        const next = iterator.next();
        if (next.done) break;
        this.writtenFailures.delete(next.value);
      }
    }
    return Promise.resolve();
  }

  async read(service: DiagnosticSnapshot['service'], instanceId: string): Promise<SnapshotReadResult> {
    if (!SERVICE_PATTERN.test(service) || !INSTANCE_PATTERN.test(instanceId)) {
      return Promise.resolve({ state: 'missing', snapshot: null, reason: 'invalid-identity' });
    }
    const row = this.database.connection.prepare(
      'SELECT payload FROM snapshots WHERE service = ? AND instance_id = ?',
    ).get(service, instanceId) as { payload: string } | undefined;
    if (!row) return Promise.resolve({ state: 'missing', snapshot: null });
    let snapshot: DiagnosticSnapshot;
    try {
      snapshot = JSON.parse(row.payload) as DiagnosticSnapshot;
    } catch {
      return Promise.resolve({ state: 'corrupt', snapshot: null, reason: 'invalid-json' });
    }
    if (!snapshot || snapshot.schema !== 1 || !SERVICE_PATTERN.test(String(snapshot.service))
      || typeof snapshot.instanceId !== 'string' || !Number.isSafeInteger(snapshot.pid)) {
      return Promise.resolve({ state: 'corrupt', snapshot: null, reason: 'invalid-schema' });
    }
    if (snapshot.status === 'exited') return Promise.resolve({ state: 'exited', snapshot });
    if (!this.isAlive(snapshot.pid)) return Promise.resolve({ state: 'exited', snapshot, reason: 'process-gone' });
    const age = this.now().getTime() - Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(age)) return Promise.resolve({ state: 'corrupt', snapshot: null, reason: 'invalid-time' });
    if (age > this.staleAfterMs) return Promise.resolve({ state: 'stale', snapshot, reason: 'outdated' });
    if (this.isSameProcess && !await this.isSameProcess(snapshot)) {
      return Promise.resolve({ state: 'exited', snapshot, reason: 'process-identity-changed' });
    }
    return Promise.resolve({ state: 'current', snapshot });
  }

  list(service?: DiagnosticSnapshot['service']): Promise<SnapshotReadResult[]> {
    const rows = service
      ? this.database.connection.prepare('SELECT payload FROM snapshots WHERE service = ? ORDER BY epoch_ms ASC').all(service) as Array<{ payload: string }>
      : this.database.connection.prepare('SELECT payload FROM snapshots ORDER BY epoch_ms ASC').all() as Array<{ payload: string }>;
    const results = rows.map((row) => {
      try {
        return this.classify(JSON.parse(row.payload) as DiagnosticSnapshot);
      } catch {
        return { state: 'corrupt' as SnapshotState, snapshot: null, reason: 'invalid-json' };
      }
    });
    return Promise.resolve(results);
  }

  private classify(snapshot: DiagnosticSnapshot): SnapshotReadResult {
    if (!snapshot || snapshot.schema !== 1 || !SERVICE_PATTERN.test(String(snapshot.service))
      || typeof snapshot.instanceId !== 'string' || !Number.isSafeInteger(snapshot.pid)) {
      return { state: 'corrupt', snapshot: null, reason: 'invalid-schema' };
    }
    if (snapshot.status === 'exited') return { state: 'exited', snapshot };
    if (!this.isAlive(snapshot.pid)) return { state: 'exited', snapshot, reason: 'process-gone' };
    const age = this.now().getTime() - Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(age)) return { state: 'corrupt', snapshot: null, reason: 'invalid-time' };
    if (age > this.staleAfterMs) return { state: 'stale', snapshot, reason: 'outdated' };
    return { state: 'current', snapshot };
  }

  prune(retentionMs: number, isActive: (snapshot: DiagnosticSnapshot) => boolean): Promise<number> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('Snapshot retention must be a non-negative integer.');
    const cutoff = this.now().getTime() - retentionMs;
    const rows = this.database.connection.prepare(
      'SELECT service,instance_id,payload,epoch_ms FROM snapshots',
    ).all() as Array<{ service: string; instance_id: string; payload: string; epoch_ms: number }>;
    let removed = 0;
    this.database.transaction(() => {
      for (const row of rows) {
        if (row.epoch_ms > cutoff) continue;
        let snapshot: DiagnosticSnapshot;
        try { snapshot = JSON.parse(row.payload) as DiagnosticSnapshot; } catch { continue; }
        if (this.classify(snapshot).state === 'current' || isActive(snapshot)) continue;
        const changes = this.database.connection.prepare(
          'DELETE FROM snapshots WHERE service = ? AND instance_id = ?',
        ).run(row.service, row.instance_id).changes;
        removed += Number(changes);
      }
    });
    return Promise.resolve(removed);
  }

  close(): void {
    this.writtenFailures.clear();
    if (this.ownsDatabase) this.database.close();
  }
}

export class SqliteRelayAudit implements RelayAuditPort {
  private readonly database: DiagnosticDatabase;
  private readonly ownsDatabase: boolean;

  constructor(options: SqliteAdapterOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.ownsDatabase = resolved.ownsDatabase;
  }

  append(entry: RelayAuditEntry): Promise<void> {
    const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
    const payload = {
      ts,
      userId: entry.userId ?? null,
      deviceId: entry.deviceId ?? null,
      client: entry.client ?? null,
      tool: entry.tool,
      argsHash: entry.argsHash ?? null,
      ok: entry.ok,
      ms: entry.ms ?? null,
      error: entry.error ?? null,
    };
    this.database.transaction(() => {
      this.database.connection.prepare(
        'INSERT INTO relay_audit (ts,epoch_ms,user_id,device_id,client,tool,args_hash,ok,ms,error,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        ts, ts, optional(entry.userId ?? undefined), optional(entry.deviceId ?? undefined),
        optional(entry.client ?? undefined), entry.tool, optional(entry.argsHash ?? undefined),
        entry.ok ? 1 : 0, numeric(entry.ms), optional(entry.error ?? undefined), JSON.stringify(payload),
      );
    });
    return Promise.resolve();
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

export class SqliteToolHistoryStore implements ToolHistoryStorePort {
  private readonly database: DiagnosticDatabase;
  private readonly ownsDatabase: boolean;

  constructor(options: SqliteAdapterOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.ownsDatabase = resolved.ownsDatabase;
  }

  static open(options: SqliteAdapterOptions = {}): SqliteToolHistoryStore {
    return new SqliteToolHistoryStore(options);
  }

  append(entry: ToolHistoryEntry): Promise<void> {
    const epoch = Date.parse(entry.timestamp);
    this.database.transaction(() => {
      this.database.connection.prepare(
        'INSERT INTO tool_history (ts,epoch_ms,tool_name,duration_ms,payload) VALUES (?,?,?,?,?)',
      ).run(
        entry.timestamp, Number.isFinite(epoch) ? epoch : 0, entry.toolName,
        numeric(entry.duration), JSON.stringify(entry),
      );
    });
    return Promise.resolve();
  }

  query(query: ToolHistoryQuery = {}): Promise<ToolHistoryEntry[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (query.toolName !== undefined) {
      clauses.push('tool_name = ?');
      params.push(query.toolName);
    }
    if (query.since !== undefined) {
      const since = Date.parse(query.since);
      if (Number.isFinite(since)) {
        clauses.push('epoch_ms >= ?');
        params.push(since);
      }
    }
    const limit = Number.isSafeInteger(query.maxResults) && (query.maxResults ?? 0) > 0 ? query.maxResults as number : 100;
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.connection.prepare(
      `SELECT payload FROM tool_history${where} ORDER BY epoch_ms DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as Array<{ payload: string }>;
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as ToolHistoryEntry));
  }

  prune(maxEntries: number): Promise<number> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('History entry limit must be a positive integer.');
    return Promise.resolve(capTable(this.database, 'tool_history', maxEntries));
  }

  clear(): Promise<void> {
    this.database.transaction(() => {
      this.database.connection.exec('DELETE FROM tool_history');
    });
    return Promise.resolve();
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

function capTable(database: DiagnosticDatabase, table: string, maxEntries: number): number {
  const excess = database.count(table) - maxEntries;
  if (excess <= 0) return 0;
  return Number(database.connection.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY epoch_ms ASC, rowid ASC LIMIT ?)`,
  ).run(excess).changes);
}

export interface DiagnosticsStoreStats {
  events: number;
  functions: number;
  traces: number;
  snapshots: number;
  history: number;
  audit: number;
}

export interface DiagnosticsMaintenanceResult extends DiagnosticsStoreStats {
  rotated: boolean;
}

export interface SqliteDiagnosticsStoreOptions extends SqliteSnapshotStoreOptions {}

export interface TraceQueryFilter {
  commands?: readonly string[];
  limit?: number;
}

export class SqliteDiagnosticsStore {
  readonly database: DiagnosticDatabase;
  readonly log: SqliteDiagnosticLog;
  readonly query: SqliteDiagnosticQuery;
  readonly snapshots: SqliteSnapshotStore;
  readonly audit: SqliteRelayAudit;
  readonly history: SqliteToolHistoryStore;
  readonly config: DiagnosticsRetentionConfig;

  constructor(options: SqliteDiagnosticsStoreOptions = {}) {
    const resolved = resolveDatabase(options);
    this.database = resolved.database;
    this.config = options.config ?? this.database.config;
    const shared = { database: this.database, config: this.config };
    this.log = SqliteDiagnosticLog.open(shared);
    this.query = new SqliteDiagnosticQuery(shared);
    this.snapshots = SqliteSnapshotStore.open({ ...shared, ...snapshotOptions(options) });
    this.audit = new SqliteRelayAudit(shared);
    this.history = SqliteToolHistoryStore.open(shared);
  }

  recordFunctionStats(functions: FunctionTimingSnapshot, capturedAt: string, service = 'cli', instanceId = 'main'): number {
    const epoch = Date.parse(capturedAt);
    return this.database.transaction(() => {
      const insert = this.database.connection.prepare(
        'INSERT INTO function_stats (captured_at,epoch_ms,service,instance_id,function_id,name,file,line,kind,calls,total_ms,max_ms,async_wall_ms,errors) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const entry of functions.entries) {
        insert.run(
          capturedAt, Number.isFinite(epoch) ? epoch : 0, service, instanceId, entry.id,
          entry.name, entry.file, entry.line, entry.kind, entry.calls, entry.totalMs,
          entry.maxMs, entry.asyncWallMs, entry.errors,
        );
      }
      return functions.entries.length;
    });
  }

  recordTrace(summary: TraceSummary): number {
    const epoch = Date.parse(summary.startedAt);
    return this.database.transaction(() => {
      this.database.connection.prepare(
        'INSERT INTO trace_runs (run_id,command,started_at,epoch_ms,status,error_code,payload) VALUES (?,?,?,?,?,?,?) '
        + 'ON CONFLICT(run_id) DO UPDATE SET command=excluded.command,started_at=excluded.started_at,'
        + 'epoch_ms=excluded.epoch_ms,status=excluded.status,error_code=excluded.error_code,payload=excluded.payload',
      ).run(
        summary.runId, summary.command, summary.startedAt, Number.isFinite(epoch) ? epoch : 0,
        summary.status, optional(summary.errorCode), JSON.stringify(summary),
      );
      this.database.connection.prepare('DELETE FROM trace_stages WHERE run_id = ?').run(summary.runId);
      const insert = this.database.connection.prepare(
        'INSERT INTO trace_stages (run_id,started_at,epoch_ms,stage,service,status,error_code,start_ms,duration_ms) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      for (const stage of summary.stages) {
        insert.run(
          summary.runId, summary.startedAt, Number.isFinite(epoch) ? epoch : 0, stage.stage,
          optional(stage.service), stage.status, optional(stage.errorCode), stage.startMs, stage.durationMs,
        );
      }
      return summary.stages.length;
    });
  }

  queryTraces(filter: TraceQueryFilter = {}): TraceSummary[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.commands && filter.commands.length > 0) {
      clauses.push(`command IN (${filter.commands.map(() => '?').join(', ')})`);
      params.push(...filter.commands);
    }
    const limit = Number.isSafeInteger(filter.limit) && (filter.limit ?? 0) > 0 ? filter.limit as number : 10;
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.connection.prepare(
      `SELECT payload FROM trace_runs${where} ORDER BY epoch_ms DESC, rowid DESC LIMIT ?`,
    ).all(...params, limit) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as TraceSummary);
  }

  stats(): DiagnosticsStoreStats {
    return {
      events: this.database.count('diagnostic_events'),
      functions: this.database.count('function_stats'),
      traces: this.database.count('trace_stages'),
      snapshots: this.database.count('snapshots'),
      history: this.database.count('tool_history'),
      audit: this.database.count('relay_audit'),
    };
  }

  maintain(nowMs: number = Date.now()): DiagnosticsMaintenanceResult {
    const config = this.config;
    const cutoff = (days: number): number => nowMs - days * 86_400_000;
    const result: DiagnosticsMaintenanceResult = {
      events: 0, functions: 0, traces: 0, snapshots: 0, history: 0, audit: 0, rotated: false,
    };
    const removeBefore = (table: string, column: string, threshold: number): number => Number(this.database.connection.prepare(
      `DELETE FROM ${table} WHERE ${column} < ?`,
    ).run(threshold).changes);

    this.database.transaction(() => {
      result.events = removeBefore('diagnostic_events', 'epoch_ms', cutoff(config.eventsRetentionDays));
      result.functions = removeBefore('function_stats', 'epoch_ms', cutoff(config.functionsRetentionDays));
      result.traces = removeBefore('trace_stages', 'epoch_ms', cutoff(config.tracesRetentionDays))
        + removeBefore('trace_runs', 'epoch_ms', cutoff(config.tracesRetentionDays));
      result.snapshots = removeBefore('snapshots', 'epoch_ms', cutoff(config.snapshotsRetentionDays));
      result.history = removeBefore('tool_history', 'epoch_ms', cutoff(config.historyRetentionDays));
      result.audit = removeBefore('relay_audit', 'epoch_ms', cutoff(config.auditRetentionDays));
      result.history += capTable(this.database, 'tool_history', config.historyMaxEntries);
      result.audit += capTable(this.database, 'relay_audit', config.auditMaxEntries);
    });

    const capBytes = config.maxDatabaseMiB * 1024 * 1024;
    if (databaseSize(this.database.path) > capBytes) {
      result.rotated = true;
      const tables = ['diagnostic_events', 'tool_history', 'relay_audit', 'trace_stages', 'trace_runs', 'function_stats', 'snapshots'];
      this.database.transaction(() => {
        for (const table of tables) {
          let guard = 0;
          while (this.database.count(table) > 0 && databaseSize(this.database.path) > capBytes && guard < 1_000) {
            this.database.connection.prepare(
              `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY epoch_ms ASC, rowid ASC LIMIT 200)`,
            ).run();
            guard += 1;
          }
        }
      });
      this.database.connection.exec('VACUUM');
    }
    return result;
  }

  close(): void {
    this.database.close();
  }
}

function snapshotOptions(options: SqliteDiagnosticsStoreOptions): Pick<SqliteSnapshotStoreOptions, 'staleAfterMs' | 'isAlive' | 'isSameProcess' | 'now'> {
  return {
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.isSameProcess === undefined ? {} : { isSameProcess: options.isSameProcess }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}


