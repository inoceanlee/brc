import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type BrcSettings,
  DiagnosticDatabase,
  type RelayAuditEntry,
  SqliteRelayAudit,
  diagnosticsRetentionConfig,
  openDiagnosticDatabase,
  resolveDiagnosticsDbPath,
} from 'brc-shared';
import type { RelayAudit } from '../../core/auth/ports.js';

export const RELAY_DIAGNOSTICS_SCHEMA_VERSION = 1;

const SUPPORTED_VERSIONS = new Set([RELAY_DIAGNOSTICS_SCHEMA_VERSION]);
const DAY_MS = 86_400_000;

export interface RelayAuditRetention {
  retentionDays: number;
  maxEntries: number;
}

export interface RelayAuditLogOptions {
  dbFile: string;
  env?: NodeJS.ProcessEnv;
  settings?: Readonly<BrcSettings>;
  database?: DiagnosticDatabase;
}

interface LegacyAuditRow {
  id: number;
  ts: number;
  user_id: string | null;
  device_id: string | null;
  client: string | null;
  tool: string;
  args_hash: string | null;
  ok: number;
  ms: number | null;
  error: string | null;
}

function initializeSchema(database: DiagnosticDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS relay_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_audit_imports (
      source_key TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      PRIMARY KEY (source_key, source_id)
    );
  `);
  const row = database.connection.prepare("SELECT value FROM relay_schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!row) {
    database.connection.prepare("INSERT INTO relay_schema_meta (key, value) VALUES ('schema_version', ?)").run(String(RELAY_DIAGNOSTICS_SCHEMA_VERSION));
    return;
  }
  const version = Number(row.value);
  if (!Number.isSafeInteger(version) || !SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`Unsupported Relay diagnostics schema version ${row.value}; supported versions: ${[...SUPPORTED_VERSIONS].join(', ')}.`);
  }
}

export class RelayAuditLog {
  readonly database: DiagnosticDatabase;
  readonly schemaVersion = RELAY_DIAGNOSTICS_SCHEMA_VERSION;
  private readonly port: SqliteRelayAudit;
  private readonly ownsDatabase: boolean;

  constructor(database: DiagnosticDatabase, ownsDatabase: boolean) {
    initializeSchema(database);
    this.database = database;
    this.ownsDatabase = ownsDatabase;
    this.port = new SqliteRelayAudit({ database });
  }

  static open(options: RelayAuditLogOptions): RelayAuditLog {
    if (options.database) return new RelayAuditLog(options.database, false);
    if (options.dbFile === ':memory:') {
      const connection = new DatabaseSync(':memory:');
      connection.exec(`
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
      `);
      const database = new DiagnosticDatabase(connection, ':memory:', diagnosticsRetentionConfig(options.settings));
      return new RelayAuditLog(database, true);
    }
    const dataDirectory = path.dirname(path.resolve(options.dbFile));
    const diagnosticsPath = resolveDiagnosticsDbPath(dataDirectory, options.env ?? process.env);
    const config = options.settings ? diagnosticsRetentionConfig(options.settings) : undefined;
    return new RelayAuditLog(openDiagnosticDatabase(diagnosticsPath, config), true);
  }

  append(entry: RelayAuditEntry): Promise<void> {
    return this.port.append(entry);
  }

  recentAudit(userId: string, limit = 100): RelayAudit[] {
    return this.database.connection.prepare(
      'SELECT id,ts,user_id,device_id,client,tool,args_hash,ok,ms,error FROM relay_audit WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    ).all(userId, limit) as unknown as RelayAudit[];
  }

  auditStats(userId: string): { total: number; failed: number; last24h: number } {
    const row = this.database.connection.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS last24h FROM relay_audit WHERE user_id = ?',
    ).get(Date.now() - DAY_MS, userId) as { total: number; failed: number | null; last24h: number | null };
    return { total: row.total, failed: row.failed ?? 0, last24h: row.last24h ?? 0 };
  }

  async importLegacyAudit(legacyFile: string): Promise<number> {
    const source = path.resolve(legacyFile);
    const sourceKey = createHash('sha256').update(source).digest('hex');
    const legacy = new DatabaseSync(source);
    let rows: LegacyAuditRow[] = [];
    try {
      const table = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get();
      if (!table) return 0;
      rows = legacy.prepare('SELECT id,ts,user_id,device_id,client,tool,args_hash,ok,ms,error FROM audit ORDER BY id').all() as unknown as LegacyAuditRow[];
    } finally {
      legacy.close();
    }
    return this.database.transaction((): number => {
      const mark = this.database.connection.prepare(
        'INSERT OR IGNORE INTO relay_audit_imports (source_key, source_id) VALUES (?, ?)',
      );
      const insert = this.database.connection.prepare(
        'INSERT INTO relay_audit (ts,epoch_ms,user_id,device_id,client,tool,args_hash,ok,ms,error,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      );
      let imported = 0;
      for (const row of rows) {
        if (Number(mark.run(sourceKey, row.id).changes) === 0) continue;
        const entry: RelayAuditEntry = {
          ts: Number.isFinite(row.ts) ? row.ts : Date.now(),
          userId: row.user_id ?? undefined,
          deviceId: row.device_id ?? undefined,
          client: row.client ?? undefined,
          tool: row.tool,
          argsHash: row.args_hash ?? undefined,
          ok: row.ok !== 0,
          ms: row.ms ?? undefined,
          error: row.error ?? undefined,
        };
        const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
        insert.run(
          ts, ts, entry.userId ?? null, entry.deviceId ?? null, entry.client ?? null,
          entry.tool, entry.argsHash ?? null, entry.ok ? 1 : 0, entry.ms ?? null,
          entry.error ?? null, JSON.stringify(entry),
        );
        imported += 1;
      }
      return imported;
    });
  }

  prune(retention: RelayAuditRetention): number {
    const cutoff = Math.max(Number.MIN_SAFE_INTEGER, Date.now() - retention.retentionDays * DAY_MS);
    return this.database.transaction(() => {
      let removed = Number(this.database.connection.prepare(
        'DELETE FROM relay_audit WHERE rowid IN (SELECT rowid FROM relay_audit WHERE ts < ? ORDER BY ts, id LIMIT ?)',
      ).run(cutoff, 1_000).changes);
      const excess = this.database.count('relay_audit') - retention.maxEntries;
      if (excess > 0) {
        removed += Number(this.database.connection.prepare(
          'DELETE FROM relay_audit WHERE rowid IN (SELECT rowid FROM relay_audit ORDER BY epoch_ms ASC, id ASC LIMIT ?)',
        ).run(excess).changes);
      }
      return removed;
    });
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}
