/**
 * BRC relay store on node:sqlite (Node >= 22.13, no native build).
 * Tables: users, oauth_clients, auth_codes, tokens, devices, device_codes, audit.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'); const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UserRow { id: string; username: string; password_hash: string; created_at: number }
export interface ClientRow { client_id: string; client_secret: string | null; metadata: string; created_at: number }
export interface AuthCodeRow { code: string; client_id: string; user_id: string; code_challenge: string; redirect_uri: string; scopes: string; resource: string | null; expires_at: number }
export interface TokenRow { token_hash: string; kind: 'access' | 'refresh'; client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number | null; created_at: number; revoked: number }
export interface DeviceRow { device_id: string; user_id: string; name: string; token_hash: string; platform: string | null; created_at: number; last_seen: number | null; paused: number }
export interface DeviceCodeRow { device_code: string; user_code: string; client_name: string; user_id: string | null; approved: number; denied: number; device_id: string | null; expires_at: number; created_at: number }
export interface AuditRow { id: number; ts: number; user_id: string | null; device_id: string | null; client: string | null; tool: string; args_hash: string | null; ok: number; ms: number | null; error: string | null }
export interface AuditRetentionPolicy {
 retentionDays: number;
 maxEntries: number;
}

const AUDIT_CLEANUP_BATCH_SIZE = 1_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_secret TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, paused INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS device_codes (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, device_id TEXT, client TEXT, tool TEXT NOT NULL, args_hash TEXT, ok INTEGER NOT NULL, ms INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS brc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
`;

const REQUIRED_TABLES = ['users', 'oauth_clients', 'auth_codes', 'tokens', 'devices', 'device_codes', 'audit'];

const USER_REFERENCE_TABLES = [
  {
    name: 'auth_codes',
    columns: ['code', 'client_id', 'user_id', 'code_challenge', 'redirect_uri', 'scopes', 'resource', 'expires_at'],
    create: (table: string) => `CREATE TABLE ${table} (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL)`,
  },
  {
    name: 'tokens',
    columns: ['token_hash', 'kind', 'client_id', 'user_id', 'scopes', 'resource', 'expires_at', 'created_at', 'revoked'],
    create: (table: string) => `CREATE TABLE ${table} (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  },
  {
    name: 'devices',
    columns: ['device_id', 'user_id', 'name', 'token_hash', 'platform', 'created_at', 'last_seen', 'paused'],
    create: (table: string) => `CREATE TABLE ${table} (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen INTEGER, paused INTEGER NOT NULL DEFAULT 0)`,
  },
  {
    name: 'device_codes',
    columns: ['device_code', 'user_code', 'client_name', 'user_id', 'approved', 'denied', 'device_id', 'expires_at', 'created_at'],
    create: (table: string) => `CREATE TABLE ${table} (device_code TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  },
  {
    name: 'api_keys',
    columns: ['key_hash', 'user_id', 'name', 'prefix', 'created_at', 'last_used', 'revoked'],
    create: (table: string) => `CREATE TABLE ${table} (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`,
  },
];

export class SqliteStore {
  readonly #db: DatabaseSync;

  static open(file: string): SqliteStore {
    const isMemory = file === ':memory:';
    if (!isMemory && !existsSync(file)) {
      throw new Error(`Relay database is missing at ${file}; run brc setup for a new data root or restore the existing database.`);
    }
    const db = new DatabaseSync(file);
    try {
      return new SqliteStore(file, db, isMemory);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  static initialize(file: string): void {
    if (file === ':memory:') throw new Error('Cannot initialize a persistent Relay database at :memory:.');
    if (existsSync(file)) {
      const store = SqliteStore.open(file);
      store.close();
      return;
    }
    const resolved = path.resolve(file);
    mkdirSync(path.dirname(resolved), { recursive: true });
    try {
      writeFileSync(resolved, '', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const store = SqliteStore.open(resolved);
        store.close();
        return;
      }
      throw error;
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(resolved);
      const store = new SqliteStore(resolved, db, true);
      store.close();
    } catch (error) {
      try { db?.close(); } catch {}
      rmSync(resolved, { force: true });
      rmSync(`${resolved}-wal`, { force: true });
      rmSync(`${resolved}-shm`, { force: true });
      throw error;
    }
  }

  private constructor(file: string, db: DatabaseSync, isNew: boolean) {
    this.#db = db;
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    if (isNew) this.initializeNewDatabase();
    else this.migrateExistingDatabase(file);
  }

  private initializeNewDatabase(): void {
    this.#db.exec(SCHEMA);
    this.#db.prepare('INSERT INTO brc_meta (key, value) VALUES (?, ?)').run('admin_bootstrap', 'pending');
  }

  private migrateExistingDatabase(file: string): void {
    const missingTables = REQUIRED_TABLES.filter((table) => !this.tableExists(table));
    if (missingTables.length) {
      throw new Error(`Relay database is missing required tables: ${missingTables.join(', ')}.`);
    }
    const tablesToMigrate = USER_REFERENCE_TABLES.filter((table) =>
      this.tableExists(table.name) && !this.hasUserForeignKey(table.name),
    );
    const needsMetadata = !this.tableExists('brc_meta');
    if (!tablesToMigrate.length && !needsMetadata) {
      const orphaned = this.orphanedUserReferences();
      if (orphaned.length) {
        const backup = this.createMigrationBackup(file);
        const counts = orphaned.map(({ table, count }) => `${table}=${count}`).join(', ');
        throw new Error(`Relay database contains orphaned user references: ${counts}. Backup: ${backup}`);
      }
      const violations = this.#db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        const backup = this.createMigrationBackup(file);
        throw new Error(`Relay database foreign_key_check failed with ${violations.length} violation(s). Backup: ${backup}`);
      }
      this.validateBootstrapState();
      return;
    }

    const backup = this.createMigrationBackup(file);
    const orphaned = this.orphanedUserReferences();
    if (orphaned.length) {
      const counts = orphaned.map(({ table, count }) => `${table}=${count}`).join(', ');
      throw new Error(`Relay database contains orphaned user references: ${counts}. Backup: ${backup}`);
    }

    const userCount = this.userCount();
    if (needsMetadata && userCount === 0) {
      throw new Error(`Existing Relay database is missing its administrator user. Backup: ${backup}`);
    }

    let inTransaction = false;
    try {
      this.#db.exec('PRAGMA foreign_keys = OFF;');
      this.#db.exec('BEGIN IMMEDIATE;');
      inTransaction = true;
      for (const table of tablesToMigrate) {
        const temporary = `${table.name}_with_user_fk`;
        this.#db.exec(table.create(temporary));
        const columns = table.columns.join(', ');
        this.#db.exec(`INSERT INTO "${temporary}" (${columns}) SELECT ${columns} FROM "${table.name}"`);
        this.#db.exec(`DROP TABLE "${table.name}"`);
        this.#db.exec(`ALTER TABLE "${temporary}" RENAME TO "${table.name}"`);
      }
      if (needsMetadata) {
        this.#db.exec('CREATE TABLE brc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.#db.prepare('INSERT INTO brc_meta (key, value) VALUES (?, ?)').run('admin_bootstrap', 'complete');
      }
      const violations = this.#db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error(`foreign_key_check reported ${violations.length} violation(s).`);
      const integrity = this.#db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check !== 'ok') throw new Error(`integrity_check failed: ${integrity.integrity_check}`);
      this.#db.exec('COMMIT;');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) {
        try { this.#db.exec('ROLLBACK;'); } catch {}
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Relay database identity migration failed; original data was preserved. Backup: ${backup}. ${detail}`);
    } finally {
      this.#db.exec('PRAGMA foreign_keys = ON;');
    }
    this.validateBootstrapState();
  }

  private createMigrationBackup(file: string): string {
    const backup = `${path.resolve(file)}.pre-identity-migration-${Date.now()}-${randomToken(6)}.bak`;
    this.#db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    return backup;
  }

  private tableExists(name: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  private hasUserForeignKey(table: string): boolean {
    return this.#db.prepare(`PRAGMA foreign_key_list(${table})`).all().some((row) => {
      const foreignKey = row as { table: string; from: string; to: string; on_delete: string };
      return foreignKey.table === 'users' && foreignKey.from === 'user_id' && foreignKey.to === 'id' && foreignKey.on_delete === 'RESTRICT';
    });
  }

  private userCount(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  }
  private orphanedUserReferences() {
    return USER_REFERENCE_TABLES
      .filter((table) => this.tableExists(table.name))
      .map((table) => {
        const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}" AS child LEFT JOIN users AS parent ON parent.id = child.user_id WHERE child.user_id IS NOT NULL AND parent.id IS NULL`).get() as { count: number };
        return { table: table.name, count: row.count };
      })
      .filter((item) => item.count > 0);
  }

  private bootstrapState(): string | undefined {
    if (!this.tableExists('brc_meta')) return undefined;
    const row = this.#db.prepare('SELECT value FROM brc_meta WHERE key = ?').get('admin_bootstrap') as { value: string } | undefined;
    return row?.value;
  }

  private validateBootstrapState(): void {
    const state = this.bootstrapState();
    const users = this.userCount();
    if (state === 'pending' && users === 0) return;
    if (state === 'complete' && users > 0) return;
    throw new Error('Relay database is missing a valid administrator identity; refusing to create a replacement.');
  }

  /* ---------- users ---------- */
  /** Initial provisioning: persist only a password hash and a stable session key. */
  bootstrapAdministrator(username: string, password: string): void {
    if (!username.trim() || password.length < 8) {
      throw new Error('Administrator username and password (at least 8 characters) are required.');
    }
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      if (this.bootstrapState() !== 'pending' || this.userCount() !== 0) {
        throw new Error('Relay administrator is already initialized.');
      }
      const user: UserRow = {
        id: randomToken(12),
        username: username.trim(),
        password_hash: hashPassword(password),
        created_at: Date.now(),
      };
      this.#db.prepare('INSERT INTO users VALUES (?,?,?,?)')
        .run(user.id, user.username, user.password_hash, user.created_at);
      this.#db.prepare('INSERT INTO brc_meta (key, value) VALUES (?, ?)')
        .run('session_secret', randomBytes(32).toString('hex'));
      this.#db.prepare('UPDATE brc_meta SET value = ? WHERE key = ?').run('complete', 'admin_bootstrap');
      this.#db.exec('COMMIT;');
    } catch (error) {
      this.#db.exec('ROLLBACK;');
      throw error;
    }
  }

  getAdministrator(): UserRow {
    const users = this.#db.prepare('SELECT * FROM users LIMIT 2').all() as unknown as UserRow[];
    if (this.bootstrapState() !== 'complete' || users.length !== 1) {
      throw new Error('Relay administrator identity is missing or ambiguous; refusing to start.');
    }
    return users[0];
  }

  getSessionSecret(): string {
    const row = this.#db.prepare('SELECT value FROM brc_meta WHERE key = ?')
      .get('session_secret') as { value: string } | undefined;
    if (!row || !/^[0-9a-f]{64}$/.test(row.value)) {
      throw new Error('Relay session secret is missing or invalid; refusing to start.');
    }
    return row.value;
  }

  getUserByName(username: string): UserRow | undefined {
    return this.#db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }
  getUser(id: string): UserRow | undefined {
    return this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  upsertUser(username: string, password: string): UserRow {
    const existing = this.getUserByName(username);
    if (existing) {
      if (verifyPassword(password, existing.password_hash)) return existing;
      const hash = hashPassword(password);
      this.#db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
      return { ...existing, password_hash: hash };
    }
    if (this.bootstrapState() !== 'pending' || this.userCount() !== 0) {
      throw new Error(`Relay database is missing configured administrator "${username}"; refusing to create a replacement identity.`);
    }
    const row: UserRow = { id: randomToken(12), username, password_hash: hashPassword(password), created_at: Date.now() };
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const concurrent = this.getUserByName(username);
      if (concurrent) {
        this.#db.exec('COMMIT;');
        return this.upsertUser(username, password);
      }
      if (this.bootstrapState() !== 'pending' || this.userCount() !== 0) {
        throw new Error(`Relay database is missing configured administrator "${username}"; refusing to create a replacement identity.`);
      }
      this.#db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(row.id, row.username, row.password_hash, row.created_at);
      this.#db.prepare('UPDATE brc_meta SET value = ? WHERE key = ?').run('complete', 'admin_bootstrap');
      this.#db.exec('COMMIT;');
      return row;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch {}
      throw error;
    }
  }

  /* ---------- oauth clients ---------- */
  getClient(clientId: string): ClientRow | undefined {
    return this.#db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
  }
  insertClient(row: ClientRow): void {
    this.#db.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?)').run(row.client_id, row.client_secret, row.metadata, row.created_at);
  }

  /* ---------- auth codes ---------- */
  insertAuthCode(row: AuthCodeRow): void {
    this.#db.prepare('INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,?)')
      .run(row.code, row.client_id, row.user_id, row.code_challenge, row.redirect_uri, row.scopes, row.resource, row.expires_at);
  }
  takeAuthCode(code: string): AuthCodeRow | undefined {
    const row = this.#db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code) as AuthCodeRow | undefined;
    if (row) this.#db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code);
    return row && row.expires_at > Date.now() ? row : undefined;
  }
  peekAuthCode(code: string): AuthCodeRow | undefined {
    const row = this.#db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code) as AuthCodeRow | undefined;
    return row && row.expires_at > Date.now() ? row : undefined;
  }

  /* ---------- tokens ---------- */
  insertToken(row: TokenRow): void {
    this.#db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.token_hash, row.kind, row.client_id, row.user_id, row.scopes, row.resource, row.expires_at, row.created_at, row.revoked);
  }
  getToken(raw: string, kind: 'access' | 'refresh'): TokenRow | undefined {
    const row = this.#db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND revoked = 0').get(sha256(raw), kind) as TokenRow | undefined;
    if (!row) return undefined;
    if (row.expires_at && row.expires_at < Date.now()) return undefined;
    return row;
  }
  revokeToken(raw: string): void {
    this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(sha256(raw));
  }
  revokeTokensForClient(clientId: string, userId?: string): void {
    if (userId) this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ? AND user_id = ?').run(clientId, userId);
    else this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
  }

  /* ---------- devices ---------- */
  getDeviceByToken(raw: string): DeviceRow | undefined {
    return this.#db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha256(raw)) as DeviceRow | undefined;
  }
  getDevice(deviceId: string): DeviceRow | undefined {
    return this.#db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as DeviceRow | undefined;
  }
  listDevices(userId: string): DeviceRow[] {
    return this.#db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as DeviceRow[];
  }
  /** Creates (or re-keys) a device and returns the raw token once. */
  issueDeviceToken(deviceId: string, userId: string, name: string, platform: string | null): string {
    const raw = `brc_dev_${randomToken(32)}`;
    const existing = this.getDevice(deviceId);
    if (existing) {
      this.#db.prepare('UPDATE devices SET token_hash = ?, name = ?, platform = ?, user_id = ? WHERE device_id = ?').run(sha256(raw), name, platform, userId, deviceId);
    } else {
      this.#db.prepare('INSERT INTO devices (device_id, user_id, name, token_hash, platform, created_at) VALUES (?,?,?,?,?,?)')
        .run(deviceId, userId, name, sha256(raw), platform, Date.now());
    }
    return raw;
  }
  touchDevice(deviceId: string): void {
    this.#db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?').run(Date.now(), deviceId);
  }
  setDevicePaused(deviceId: string, paused: boolean): void {
    this.#db.prepare('UPDATE devices SET paused = ? WHERE device_id = ?').run(paused ? 1 : 0, deviceId);
  }
  deleteDevice(deviceId: string): void {
    this.#db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  }

  /* ---------- device pairing codes ---------- */
  createDeviceCode(clientName: string, ttlMs: number): DeviceCodeRow {
    const row: DeviceCodeRow = {
      device_code: randomToken(32), user_code: SqliteStore.userCode(), client_name: clientName,
      user_id: null, approved: 0, denied: 0, device_id: null, expires_at: Date.now() + ttlMs, created_at: Date.now(),
    };
    this.#db.prepare('INSERT INTO device_codes VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.device_code, row.user_code, row.client_name, row.user_id, row.approved, row.denied, row.device_id, row.expires_at, row.created_at);
    return row;
  }
  getDeviceCode(deviceCode: string): DeviceCodeRow | undefined {
    return this.#db.prepare('SELECT * FROM device_codes WHERE device_code = ?').get(deviceCode) as DeviceCodeRow | undefined;
  }
  getDeviceCodeByUserCode(userCode: string): DeviceCodeRow | undefined {
    return this.#db.prepare('SELECT * FROM device_codes WHERE user_code = ?').get(userCode.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2')) as DeviceCodeRow | undefined;
  }
  approveDeviceCode(deviceCode: string, userId: string, deviceId: string): void {
    this.#db.prepare('UPDATE device_codes SET approved = 1, user_id = ?, device_id = ? WHERE device_code = ?').run(userId, deviceId, deviceCode);
  }
  denyDeviceCode(deviceCode: string): void {
    this.#db.prepare('UPDATE device_codes SET denied = 1 WHERE device_code = ?').run(deviceCode);
  }
  deleteDeviceCode(deviceCode: string): void {
    this.#db.prepare('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode);
  }
  private static userCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  /* ---------- audit ---------- */
  audit(row: Omit<AuditRow, 'id'>): void {
    this.#db.prepare('INSERT INTO audit (ts,user_id,device_id,client,tool,args_hash,ok,ms,error) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.ts, row.user_id, row.device_id, row.client, row.tool, row.args_hash, row.ok, row.ms, row.error);
  }
  recentAudit(userId: string, limit = 100): AuditRow[] {
    return this.#db.prepare('SELECT * FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as unknown as AuditRow[];
  }

 /** Housekeeping: drop expired codes, tokens, and bounded audit batches. */
 vacuumExpired(audit: AuditRetentionPolicy): void {
    const now = Date.now();
    this.#db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM device_codes WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(now - 7 * 86_400_000);

  const retentionCutoff = Math.max(Number.MIN_SAFE_INTEGER, now - audit.retentionDays * 86_400_000);
  this.#db.prepare(
   'DELETE FROM audit WHERE id IN (SELECT id FROM audit INDEXED BY audit_ts WHERE ts < ? ORDER BY ts, id LIMIT ?)',
  ).run(retentionCutoff, AUDIT_CLEANUP_BATCH_SIZE);

  this.#db.prepare(
   'DELETE FROM audit WHERE id < (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)',
  ).run(audit.maxEntries - 1);
  }

  /* ---------- OAuth clients (management) ---------- */
  listClients(): ClientRow[] {
    return this.#db.prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC').all() as unknown as ClientRow[];
  }
  deleteClient(clientId: string): void {
    this.#db.prepare('UPDATE tokens SET revoked = 1 WHERE client_id = ?').run(clientId);
    this.#db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
  }

  renameDevice(deviceId: string, name: string): void {
    this.#db.prepare('UPDATE devices SET name = ? WHERE device_id = ?').run(name, deviceId);
  }
  auditStats(userId: string): { total: number; failed: number; last24h: number } {
    const row = this.#db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS last24h FROM audit WHERE user_id = ?').get(Date.now() - 86_400_000, userId) as { total: number; failed: number | null; last24h: number | null };
    return { total: row.total, failed: row.failed ?? 0, last24h: row.last24h ?? 0 };
  }

  /* ---------- API keys (static bearer tokens) ---------- */
  private ensureApiKeys(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0)');
  }
  createApiKey(userId: string, name: string): { raw: string; prefix: string } {
    this.ensureApiKeys();
    const raw = `brc_ak_${randomToken(32)}`;
    const prefix = raw.slice(0, 18);
    this.#db.prepare('INSERT INTO api_keys (key_hash, user_id, name, prefix, created_at) VALUES (?,?,?,?,?)').run(sha256(raw), userId, name, prefix, Date.now());
    return { raw, prefix };
  }
  getApiKey(raw: string): { user_id: string; name: string; prefix: string } | undefined {
    this.ensureApiKeys();
    const row = this.#db.prepare('SELECT user_id, name, prefix FROM api_keys WHERE key_hash = ? AND revoked = 0').get(sha256(raw)) as { user_id: string; name: string; prefix: string } | undefined;
    if (row) this.#db.prepare('UPDATE api_keys SET last_used = ? WHERE key_hash = ?').run(Date.now(), sha256(raw));
    return row;
  }
  listApiKeys(userId: string): { prefix: string; name: string; created_at: number; last_used: number | null }[] {
    this.ensureApiKeys();
    return this.#db.prepare('SELECT prefix, name, created_at, last_used FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').all(userId) as unknown as { prefix: string; name: string; created_at: number; last_used: number | null }[];
  }
  revokeApiKey(userId: string, prefix: string): void {
    this.ensureApiKeys();
    this.#db.prepare('UPDATE api_keys SET revoked = 1 WHERE user_id = ? AND prefix = ?').run(userId, prefix);
  }

  close(): void { this.#db.close(); }
}