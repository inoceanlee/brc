import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MARKER_TABLE = 'relay_identity_imports';

export function legacyIdentitySourceKey(legacyFile: string): string {
  return createHash('sha256').update(path.resolve(legacyFile)).digest('hex');
}

export function markLegacyIdentityImported(diagnosticsDbPath: string, legacyFile: string): void {
  const resolved = path.resolve(diagnosticsDbPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (source_key TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)`);
    database.prepare(`INSERT OR IGNORE INTO ${MARKER_TABLE} (source_key, imported_at) VALUES (?, ?)`)
      .run(legacyIdentitySourceKey(legacyFile), Date.now());
  } finally {
    database.close();
  }
}
