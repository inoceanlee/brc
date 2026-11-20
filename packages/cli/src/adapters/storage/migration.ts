import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrcPaths } from '../../config/paths.js';

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

export function discoverLegacyIdentityCandidates(
  paths: BrcPaths,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): readonly LegacyIdentityCandidate[] {
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
