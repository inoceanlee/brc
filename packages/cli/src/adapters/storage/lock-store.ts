import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from '../../config/paths.js';
import type { ProcessIdentity } from '../process/identity.js';

export interface LockOwner extends ProcessIdentity {
  version: 1;
  workspaceRoot: string;
  token: string;
}
interface LockSnapshot { owner: LockOwner; contents: string; dev: number; ino: number; birthtimeMs: number; }

function code(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}
function validOwner(value: unknown, root: string): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && v.workspaceRoot === root
    && typeof v.token === 'string' && /^[0-9a-f-]{36}$/i.test(v.token)
    && typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 0
    && typeof v.createdAt === 'string' && v.createdAt.length > 0
    && typeof v.executablePath === 'string' && path.isAbsolute(v.executablePath)
    && typeof v.commandLine === 'string' && v.commandLine.length > 0;
}
function sameSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
    && a.contents === b.contents;
}

export class LockStore {
  readonly lockPath: string;
  constructor(private readonly paths: BrcPaths) {
    this.lockPath = path.join(paths.runtime, 'lifecycle.lock');
  }

  private async verifyDirectory(dir: string): Promise<void> {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Lifecycle lock path is not a plain directory.');
    }
  }

  async acquire(owner: LockOwner): Promise<boolean> {
    if (!validOwner(owner, this.paths.root)) throw new Error('Invalid lifecycle lock owner.');
    try {
      await this.verifyDirectory(this.paths.root);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      await mkdir(this.paths.root, { recursive: true });
      await this.verifyDirectory(this.paths.root);
    }
    try { await mkdir(this.paths.runtime); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; }
    await this.verifyDirectory(this.paths.runtime);
    const stage = await mkdtemp(path.join(this.paths.runtime, '.lifecycle-stage-'));
    try {
      await writeFile(path.join(stage, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      // Exclusive mkdir prevents Windows rename from replacing an existing lock file.
      // A crash before owner publication leaves a detectable, unclaimed directory.
      try {
        await mkdir(this.lockPath);
      } catch (error) {
        if (code(error) !== 'EEXIST' && code(error) !== 'EPERM' && code(error) !== 'EACCES') throw error;
        try { await lstat(this.lockPath); return false; }
        catch (probe) { if (code(probe) === 'ENOENT') throw error; throw probe; }
      }
      await rename(path.join(stage, 'owner.json'), path.join(this.lockPath, 'owner.json'));
      return true;
    } finally {
      try { await unlink(path.join(stage, 'owner.json')); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      try { await rmdir(stage); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    }
  }

  async isMissing(): Promise<boolean> {
    try { await lstat(this.lockPath); return false; }
    catch (error) { if (code(error) === 'ENOENT') return true; throw error; }
  }

  async readOwner(): Promise<LockSnapshot> {
    await this.verifyDirectory(this.paths.runtime);
    const info = await lstat(this.lockPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Lifecycle lock is not a plain directory.');
    const filename = path.join(this.lockPath, 'owner.json');
    const fileInfo = await lstat(filename);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Lifecycle lock owner is not a plain file.');
    const contents = await readFile(filename, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(contents) as unknown; }
    catch { throw new Error('Lifecycle lock owner is malformed.'); }
    if (!validOwner(parsed, this.paths.root)) throw new Error('Lifecycle lock owner is incomplete or belongs to another data root.');
    return { owner: parsed, contents, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
  }

  async isolateAndDelete(snapshot: LockSnapshot, verify?: () => Promise<boolean>): Promise<void> {
    const current = await this.readOwner();
    if (!sameSnapshot(snapshot, current)) throw new Error('Lifecycle lock changed before isolation.');
    const moved = path.join(this.paths.runtime, '.lifecycle-isolated-' + randomUUID());
    await rename(this.lockPath, moved);
    let safe = false;
    try {
      const isolated = await this.readMoved(moved);
      if (!sameSnapshot(snapshot, isolated)) throw new Error('Lifecycle lock was replaced during isolation.');
      if (verify && !await verify()) throw new Error('Lifecycle lock owner changed during recovery.');
      // Refuse to remove any unexpected new files or ownership changes.
      const final = await this.readMoved(moved);
      if (!sameSnapshot(snapshot, final)) throw new Error('Lifecycle lock changed after isolation.');
      safe = true;
      await unlink(path.join(moved, 'owner.json'));
      await rmdir(moved);
    } catch (error) {
      if (!safe) {
        try { await rename(moved, this.lockPath); } catch { /* Preserve isolated contents for investigation. */ }
      }
      throw error;
    }
  }

  private async readMoved(dir: string): Promise<LockSnapshot> {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Isolated lock is not a plain directory.');
    const file = path.join(dir, 'owner.json');
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Isolated owner is not a plain file.');
    const contents = await readFile(file, 'utf8');
    const value: unknown = JSON.parse(contents);
    if (!validOwner(value, this.paths.root)) throw new Error('Isolated lock owner is invalid.');
    return { owner: value, contents, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
  }

  async releaseIfOwned(token: string): Promise<void> {
    let snapshot: LockSnapshot;
    try { snapshot = await this.readOwner(); }
    catch (error) { if (code(error) === 'ENOENT') return; throw error; }
    if (snapshot.owner.token !== token) return;
    await this.isolateAndDelete(snapshot);
  }

  async reclaimExpired(inspect: (pid: number) => Promise<ProcessIdentity | null>): Promise<boolean> {
    const snapshot = await this.readOwner();
    const identity = await inspect(snapshot.owner.pid);
    if (identity) {
      const isOwner = identity.createdAt === snapshot.owner.createdAt
        && identity.executablePath === snapshot.owner.executablePath
        && identity.commandLine === snapshot.owner.commandLine;
      if (isOwner) return false;
    }
    await this.isolateAndDelete(snapshot, async () => {
      const current = await inspect(snapshot.owner.pid);
      if (!current) return true;
      return current.createdAt !== snapshot.owner.createdAt
        || current.executablePath !== snapshot.owner.executablePath
        || current.commandLine !== snapshot.owner.commandLine;
    });
    return true;
  }
}
