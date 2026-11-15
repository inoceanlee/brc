import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiagnosticSnapshot,
  DiagnosticSnapshotPort,
  SnapshotReadResult,
  SnapshotState,
} from '../core/ports.js';

export interface FileSnapshotStoreOptions {
  directory: string;
  staleAfterMs?: number;
  maxBytes?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
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

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function ensurePlainDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error('Diagnostic snapshot directory must be absolute.');
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Diagnostic snapshot directory must be a plain directory.');
  }
}

function validateIdentity(service: string, instanceId: string): void {
  if (!SERVICE_PATTERN.test(service)) throw new Error(`Unknown diagnostic snapshot service: ${service}`);
  if (!INSTANCE_PATTERN.test(instanceId)) throw new Error('Diagnostic snapshot instance id is not safe.');
}

function snapshotFile(directory: string, service: string, instanceId: string): string {
  return path.join(directory, `${service}-${instanceId}.json`);
}

const REPLACE_RETRY_MS = 20;
const REPLACE_ATTEMPTS = 10;

/**
 * Windows can reject a rename while a reader holds the target open, so the
 * replace is retried briefly. The rename itself stays atomic; a failed
 * replace never leaves a partial file at the target path.
 */
async function replaceAtomically(temporary: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retryable || attempt >= REPLACE_ATTEMPTS) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, REPLACE_RETRY_MS);
      await promise;
    }
  }
}

/**
 * Per-instance snapshots are replaced atomically (write then rename) so a
 * reader never observes a partially written record. Stale snapshots stay on
 * disk until maintenance prunes them, but readers label them explicitly.
 */
export class FileSnapshotStore implements DiagnosticSnapshotPort {
  private readonly directory: string;
  private readonly staleAfterMs: number;
  private readonly maxBytes: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => Date;

  constructor(options: FileSnapshotStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.now = options.now ?? (() => new Date());
  }

  async write(snapshot: DiagnosticSnapshot): Promise<void> {
    validateIdentity(snapshot.service, snapshot.instanceId);
    await ensurePlainDirectory(this.directory);
    const target = snapshotFile(this.directory, snapshot.service, snapshot.instanceId);
    const payload = this.serialize(snapshot);
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceAtomically(temporary, target);
  }

  private serialize(snapshot: DiagnosticSnapshot): string {
    let payload = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(payload) <= this.maxBytes) return payload;
    const entries = [...snapshot.functions.entries];
    while (entries.length > 0) {
      entries.length = Math.floor(entries.length / 2);
      payload = `${JSON.stringify({
        ...snapshot,
        functions: { ...snapshot.functions, entries, truncated: true },
      })}\n`;
      if (Buffer.byteLength(payload) <= this.maxBytes) return payload;
    }
    const minimal: DiagnosticSnapshot = {
      ...snapshot,
      functions: { schema: 1, totalCalls: snapshot.functions.totalCalls, entries: [], truncated: true, droppedIds: snapshot.functions.droppedIds },
    };
    payload = `${JSON.stringify(minimal)}\n`;
    if (Buffer.byteLength(payload) > this.maxBytes) throw new Error('Diagnostic snapshot exceeds the configured size limit.');
    return payload;
  }

  async read(service: DiagnosticSnapshot['service'], instanceId: string): Promise<SnapshotReadResult> {
    if (!SERVICE_PATTERN.test(service) || !INSTANCE_PATTERN.test(instanceId)) {
      return { state: 'missing', snapshot: null, reason: 'invalid-identity' };
    }
    return this.readFile(snapshotFile(this.directory, service, instanceId));
  }

  async list(service?: DiagnosticSnapshot['service']): Promise<SnapshotReadResult[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const results: SnapshotReadResult[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^(cli|relay|agent|traefik)-[A-Za-z0-9_.-]{1,128}\.json$/.test(entry.name)) continue;
      if (service && !entry.name.startsWith(`${service}-`)) continue;
      results.push(await this.readFile(path.join(this.directory, entry.name)));
    }
    return results.sort((left, right) => (left.snapshot?.capturedAt ?? '').localeCompare(right.snapshot?.capturedAt ?? ''));
  }

  private async readFile(filename: string): Promise<SnapshotReadResult> {
    let text: string;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) {
        return { state: 'corrupt', snapshot: null, reason: 'not-a-file' };
      }
      text = await readFile(filename, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { state: 'missing', snapshot: null };
      throw error;
    }
    let snapshot: DiagnosticSnapshot;
    try {
      snapshot = JSON.parse(text) as DiagnosticSnapshot;
    } catch {
      return { state: 'corrupt', snapshot: null, reason: 'invalid-json' };
    }
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

  async prune(retentionMs: number, isActive: (snapshot: DiagnosticSnapshot) => boolean): Promise<number> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('Snapshot retention must be a non-negative integer.');
    let removed = 0;
    for (const result of await this.list()) {
      const snapshot = result.snapshot;
      if (!snapshot || result.state === 'current') continue;
      if (isActive(snapshot)) continue;
      const age = this.now().getTime() - Date.parse(snapshot.capturedAt);
      if (Number.isFinite(age) && age <= retentionMs) continue;
      try {
        await unlink(snapshotFile(this.directory, snapshot.service, snapshot.instanceId));
        removed += 1;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}

export function snapshotStateLabel(state: SnapshotState): string {
  switch (state) {
    case 'current': return 'current';
    case 'exited': return 'exited';
    case 'stale': return 'stale';
    case 'corrupt': return 'corrupt';
    default: return 'missing';
  }
}
