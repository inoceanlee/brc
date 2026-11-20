import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveDiagnosticsDbPath } from 'brc-shared';
import { markLegacyIdentityImported } from './legacy-import-marker.js';

const LEGACY_REQUIRED_TABLES = ['users', 'oauth_clients', 'auth_codes', 'tokens', 'devices', 'device_codes', 'brc_meta'];

export interface LegacyIdentityImportResult {
  legacyFile: string;
  targetFile: string;
  stagingFile: string;
  users: number;
  devices: number;
  tokens: number;
  legacyRemoved: boolean;
  warnings: string[];
}

export interface LegacyIdentityImportOptions {
  diagnosticsDbPath?: string;
  removeLegacyArtifacts?: (legacyFile: string) => void;
}

interface IdentitySnapshot {
  users: number;
  devices: number;
  tokens: number;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function verifyDatabase(db: DatabaseSync): IdentitySnapshot {
  const missing = LEGACY_REQUIRED_TABLES.filter((table) =>
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  if (missing.length) {
    throw new Error(`Relay database is missing required tables: ${missing.join(', ')}.`);
  }
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity.integrity_check !== 'ok') {
    throw new Error(`Relay database integrity_check failed: ${integrity.integrity_check}`);
  }
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    throw new Error(`Relay database foreign_key_check failed with ${violations.length} violation(s).`);
  }
  return {
    users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
    devices: (db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n,
    tokens: (db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n,
  };
}

function verifyIdentityUsable(db: DatabaseSync): void {
  const metaValue = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM brc_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const schemaVersion = metaValue('schema_version');
  if (!schemaVersion || !/^\d+$/.test(schemaVersion)) {
    throw new Error('Relay identity import verification failed: schema version is missing.');
  }
  const sessionSecret = metaValue('session_secret');
  if (!sessionSecret || !/^[0-9a-f]{64}$/.test(sessionSecret)) {
    throw new Error('Relay identity import verification failed: session secret is missing or invalid.');
  }
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (users < 1) {
    throw new Error('Relay identity import verification failed: no administrator identity is present.');
  }
}

function discardStaging(staging: string): void {
  for (const file of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) {
    try { rmSync(file, { force: true }); } catch { }
  }
}

function removeLegacyIdentityArtifacts(legacyFile: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${legacyFile}${suffix}`, { force: true });
  }
}

export function importLegacyIdentityDatabase(
  legacyFile: string,
  targetFile: string,
  options: LegacyIdentityImportOptions = {},
): LegacyIdentityImportResult {
  const legacy = path.resolve(legacyFile);
  const target = path.resolve(targetFile);
  if (!existsSync(legacy)) throw new Error(`Legacy Relay database is missing at ${legacy}.`);
  if (!lstatSync(legacy).isFile()) throw new Error(`Legacy Relay database is not a regular file: ${legacy}.`);
  if (existsSync(target)) throw new Error(`Relay database already exists at ${target}; refusing to replace it.`);

  const staging = `${target}.legacy-staging`;
  let source: DatabaseSync | undefined;
  let snapshot: IdentitySnapshot | undefined;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    source = new DatabaseSync(legacy);
    const before = verifyDatabase(source);
    source.exec(`VACUUM INTO ${quote(staging)}`);
    source.close();
    source = undefined;

    const staged = new DatabaseSync(staging);
    try {
      snapshot = verifyDatabase(staged);
      verifyIdentityUsable(staged);
    } finally {
      staged.close();
    }
    if (snapshot.users !== before.users || snapshot.devices !== before.devices || snapshot.tokens !== before.tokens) {
      throw new Error('Relay identity import staging verification failed: identity counts differ.');
    }
    if (existsSync(target)) throw new Error(`Relay database appeared during import at ${target}; refusing to replace it.`);
    renameSync(staging, target);

    const warnings: string[] = [];
    const diagnosticsPath = options.diagnosticsDbPath
      ? path.resolve(options.diagnosticsDbPath)
      : resolveDiagnosticsDbPath(path.dirname(target), process.env);
    try {
      markLegacyIdentityImported(diagnosticsPath, legacy);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to record legacy identity import marker: ${detail}`);
    }

    let legacyRemoved = false;
    try {
      (options.removeLegacyArtifacts ?? removeLegacyIdentityArtifacts)(legacy);
      legacyRemoved = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to remove legacy identity database: ${detail}`);
    }
    for (const warning of warnings) console.warn(`Relay identity import warning: ${warning}`);

    return { legacyFile: legacy, targetFile: target, stagingFile: staging, ...snapshot, legacyRemoved, warnings };
  } catch (error) {
    discardStaging(staging);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Relay identity import failed; the legacy database was preserved. ${detail}`);
  } finally {
    try { source?.close(); } catch { }
  }
}
