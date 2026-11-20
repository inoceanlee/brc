import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { resolveDiagnosticsDbPath } from 'brc-shared';
import type { BrcPaths } from '../../config/paths.js';

const MARKER_TABLE = 'relay_identity_imports';

export interface LegacyIdentityCandidate {
  readonly kind: 'identity-database';
  readonly path: string;
}

export interface MigrationShellResult {
  readonly candidates: readonly LegacyIdentityCandidate[];
}

function isInside(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourceKey(filename: string): string {
  return createHash('sha256').update(path.resolve(filename)).digest('hex');
}

function importedIdentityKeys(paths: BrcPaths, env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const diagnosticsFile = resolveDiagnosticsDbPath(paths.data ?? paths.root, env);
  if (!existsSync(diagnosticsFile)) return new Set<string>();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(diagnosticsFile);
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(MARKER_TABLE);
    if (!table) return new Set<string>();
    const rows = database.prepare(`SELECT source_key FROM ${MARKER_TABLE}`).all() as { source_key: string }[];
    return new Set(rows.map((row) => row.source_key));
  } catch {
    return new Set<string>();
  } finally {
    try { database?.close(); } catch { }
  }
}

export function discoverLegacyIdentityCandidates(
  paths: BrcPaths,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): readonly LegacyIdentityCandidate[] {
  const imported = importedIdentityKeys(paths, env);
  const legacyRoots = [path.join(homeDirectory, '.brc')];
  const override = env.BRC_LEGACY_DATA_ROOT?.trim();
  if (override) legacyRoots.push(path.resolve(override));
  const candidates: LegacyIdentityCandidate[] = [];
  const seen = new Set<string>();
  for (const root of legacyRoots) {
    for (const relative of ['data/relay.sqlite', 'relay.sqlite']) {
      const filename = path.join(root, relative);
      const resolved = path.resolve(filename);
      if (seen.has(resolved) || isInside(paths.root, resolved) || !existsSync(resolved)) continue;
      if (imported.has(sourceKey(resolved))) continue;
      seen.add(resolved);
      candidates.push({ kind: 'identity-database', path: resolved });
    }
  }
  return candidates;
}

export function assertNoLegacyIdentity(candidates: readonly LegacyIdentityCandidate[]): void {
  if (candidates.length === 0) return;
  const paths = candidates.map((candidate) => candidate.path).join(', ');
  throw Object.assign(new Error(
    `Legacy BRC identity detected at ${paths}. Migrate the existing identity before creating a new one.`,
  ), { exitCode: 5, code: 'LEGACY_IDENTITY_DETECTED' });
}

export function runEntryMigration(
  paths: BrcPaths,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): MigrationShellResult {
  return { candidates: discoverLegacyIdentityCandidates(paths, env, homeDirectory) };
}
