import { randomInt } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from '../../config/paths.js';
import { DEFAULT_SETTINGS, type BrcSettings } from '../../config/settings.js';
import { inspectProcess, isStaleFromPreviousBoot, processDefinitelyExited, ProcessManager, type ManagedServiceName, type ProcessIdentity } from '../process/controller.js';
import { FileSnapshotStore, snapshotStateLabel } from 'brc-shared';
import { inspectProcesses } from '../process/identity.js';
import { LifecycleLock } from './lock.js';
import { LockStore } from './lock-store.js';

const SERVICE_NAMES: ManagedServiceName[] = ['relay', 'traefik', 'agent'];

export interface CleanupIssue {
  path: string;
  reason: string;
}

export interface CleanupReport {
  removed: number;
  bytesRemoved: number;
  wouldRemove: number;
  failures: CleanupIssue[];
  preserved: CleanupIssue[];
}

export interface CleanupOptions {
  dryRun?: boolean;
  settings?: Readonly<BrcSettings>;
}

interface ServiceRuntime {
  state: 'inactive' | 'active' | 'unknown';
  entrypoint?: string;
}

interface LogFile {
  path: string;
  size: number;
  modifiedAt: number;
}

interface VersionManifest {
  version: 1;
  current: string;
  previous: string | null;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function readRegularFile(filename: string): Promise<{ contents: string; size: number }> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Path is not a regular file.');
  return { contents: await readFile(filename, 'utf8'), size: info.size };
}

function issue(list: CleanupIssue[], filename: string, reason: string): void {
  list.push({ path: filename, reason });
}

function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function safeDirectory(root: string, directory: string, report: CleanupReport): Promise<boolean> {
  if (!isWithin(root, directory)) {
    issue(report.preserved, directory, 'Path is outside the BRC data root.');
    return false;
  }
  let current = path.resolve(root);
  const relative = path.relative(current, path.resolve(directory));
  try {
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        issue(report.preserved, current, 'Directory is a link or is not a directory; it was not traversed.');
        return false;
      }
    }
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    issue(report.failures, current, error instanceof Error ? error.message : String(error));
    return false;
  }
}
async function removeFile(
  root: string,
  filename: string,
  report: CleanupReport,
  dryRun: boolean,
): Promise<boolean> {
  if (!await safeDirectory(root, path.dirname(filename), report)) return false;
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) {
      issue(report.preserved, filename, 'Path is not a regular file; it was not removed.');
      return false;
    }
    if (dryRun) {
      report.wouldRemove++;
      return true;
    }
    await unlink(filename);
    report.removed++;
    report.bytesRemoved += info.size;
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    issue(report.failures, filename, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function collectFiles(root: string, directory: string, report: CleanupReport, files: LogFile[]): Promise<void> {
  if (!await safeDirectory(root, directory, report)) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    issue(report.failures, directory, error instanceof Error ? error.message : String(error));
    return;
  }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issue(report.preserved, filename, 'Symbolic links and junctions are not traversed.');
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(root, filename, report, files);
      continue;
    }
    if (!entry.isFile()) {
      issue(report.preserved, filename, 'Non-file filesystem entry was not inspected.');
      continue;
    }
    try {
      const info = await lstat(filename);
      if (info.isFile() && !info.isSymbolicLink()) files.push({ path: filename, size: info.size, modifiedAt: info.mtimeMs });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.failures, filename, error instanceof Error ? error.message : String(error));
    }
  }
}

function recordSpec(name: ManagedServiceName, value: unknown, paths: BrcPaths) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const workspaceRoot = typeof record.workspaceRoot === 'string' && path.isAbsolute(record.workspaceRoot)
    ? record.workspaceRoot
    : paths.root;
  const entrypoint = typeof record.entrypoint === 'string' && path.isAbsolute(record.entrypoint)
    ? record.entrypoint
    : path.join(paths.root, 'invalid-managed-entrypoint.js');
  return { name, entrypoint, workspaceRoot, cwd: workspaceRoot };
}

type IdentitySnapshot = Map<number, ProcessIdentity | null | Error> | Error;

async function runtimeSnapshot(paths: BrcPaths, report: CleanupReport): Promise<IdentitySnapshot> {
  if (!await safeDirectory(paths.root, paths.runtime, report)) return new Map();
  let entries;
  try {
    entries = await readdir(paths.runtime, { withFileTypes: true });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const names = new Set([...SERVICE_NAMES.map((name) => `${name}.json`), 'traefik-child.json']);
  const pids = new Set<number>();
  await Promise.all(entries.map(async (entry) => {
    if (!names.has(entry.name)
        && !entry.name.endsWith('.ready.json') && !entry.name.endsWith('.ready.json.tmp')) return;
    if (!entry.isFile() || entry.isSymbolicLink()) return;
    const entryPath = path.join(paths.runtime, entry.name);
    try {
      const fileInfo = await lstat(entryPath);
      if (isStaleFromPreviousBoot(fileInfo.mtimeMs) && !names.has(entry.name)) return;
      const value = JSON.parse((await readRegularFile(entryPath)).contents) as unknown;
      if (value && typeof value === 'object' && 'pid' in value
          && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0) pids.add(value.pid);
    } catch { /* Individual records are reported by their owner. */ }
  }));
  try {
    return await inspectProcesses([...pids]);
  } catch (error) {
    if (pids.size <= 1) return error instanceof Error ? error : new Error(String(error));
    const results = await Promise.all([...pids].map(async (pid): Promise<[number, ProcessIdentity | null | Error]> => {
      try {
        return [pid, (await inspectProcesses([pid])).get(pid) ?? null];
      } catch (individualError) {
        return [pid, individualError instanceof Error ? individualError : new Error(String(individualError))];
      }
    }));
    return new Map(results);
  }
}

function snapshotIdentity(snapshot: IdentitySnapshot, pid: number): ProcessIdentity | null {
  if (snapshot instanceof Error) throw snapshot;
  if (!snapshot.has(pid)) throw new Error('PID was not included in the identity snapshot.');
  const identity = snapshot.get(pid);
  if (identity instanceof Error) throw identity;
  return identity ?? null;
}

async function removeUnchangedRecord(
  paths: BrcPaths, filename: string, contents: string, pid: number, report: CleanupReport, dryRun: boolean,
): Promise<boolean> {
  if (await inspectProcess(pid)) {
    issue(report.preserved, filename, 'Process is live or its PID was reused during cleanup.');
    return false;
  }
  if (!await processDefinitelyExited(pid)) {
    issue(report.preserved, filename, 'Process may still be active or its state cannot be verified.');
    return false;
  }
  if (!await safeDirectory(paths.root, path.dirname(filename), report)) return false;
  if ((await readRegularFile(filename)).contents !== contents) {
    issue(report.preserved, filename, 'Record changed during cleanup.');
    return false;
  }
  return await removeFile(paths.root, filename, report, dryRun);
}

async function inspectServiceRecords(paths: BrcPaths, report: CleanupReport, dryRun: boolean, snapshot: IdentitySnapshot): Promise<Map<ManagedServiceName, ServiceRuntime>> {
  const result = new Map<ManagedServiceName, ServiceRuntime>();
  const manager = new ProcessManager(paths, { inspectProcess: (pid) => snapshotIdentity(snapshot, pid) });
  const runtimeExists = await safeDirectory(paths.root, paths.runtime, report);
  if (!runtimeExists) {
    for (const name of SERVICE_NAMES) result.set(name, { state: 'inactive' });
    return result;
  }

  const serviceEntries = await Promise.all(SERVICE_NAMES.map(async (name) => {
    const filename = path.join(paths.runtime, `${name}.json`);
    let raw: string;
    let value: unknown;
    try {
      raw = (await readRegularFile(filename)).contents;
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        result.set(name, { state: 'inactive' });
        return null;
      }
      issue(report.preserved, filename, `Process record is unreadable or damaged: ${error instanceof Error ? error.message : String(error)}`);
      result.set(name, { state: 'unknown' });
      return null;
    }
    const spec = recordSpec(name, value, paths);
    return { name, filename, raw, value, spec };
  }));

  const activeSpecs = serviceEntries.filter((item): item is NonNullable<typeof item> => item !== null);
  const statuses = await manager.statusMany(activeSpecs.map((item) => item.spec));

  for (let index = 0; index < activeSpecs.length; index++) {
    const { name, filename, raw, value, spec } = activeSpecs[index]!;
    const status = statuses[index]!;
    try {
      if ((await readRegularFile(filename)).contents !== raw) throw new Error('Process record changed during cleanup.');
      if (status.state === 'stopped') {
        if (!isWithin(spec.workspaceRoot, spec.entrypoint)) {
          throw new Error('Service entrypoint must belong to its workspace.');
        }
        if (!value || typeof value !== 'object' || !('pid' in value) || typeof value.pid !== 'number') {
          throw new Error('Process record has no valid PID.');
        }
        const removed = await removeUnchangedRecord(paths, filename, raw, value.pid, report, dryRun);
        result.set(name, { state: removed ? 'inactive' : 'unknown', entrypoint: spec.entrypoint });
      } else {
        if (status.state !== 'running' && status.state !== 'pairing') issue(report.preserved, filename, status.detail);
        result.set(name, { state: status.state === 'running' || status.state === 'pairing' ? 'active' : 'unknown', entrypoint: spec.entrypoint });
      }
    } catch (error) {
      issue(report.preserved, filename, `Process identity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
      result.set(name, { state: 'unknown', entrypoint: spec.entrypoint });
    }
  }
  return result;
}


async function cleanLifecycleLock(paths: BrcPaths, report: CleanupReport, dryRun: boolean): Promise<void> {
  const filename = path.join(paths.runtime, 'lifecycle.lock');
  const store = new LockStore(paths);
  try {
    await store.readOwner();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      issue(report.preserved, filename, `Lock owner is damaged or unverified: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  try {
    if (dryRun) {
      const owner = await store.readOwner();
      const current = await inspectProcess(owner.owner.pid);
      if (current) issue(report.preserved, filename, 'Lifecycle lock belongs to a live or reused process.');
      else report.wouldRemove++;
    } else if (await store.reclaimExpired(inspectProcess)) {
      report.removed++;
    } else {
      issue(report.preserved, filename, 'Lifecycle lock belongs to a live process.');
    }
  } catch (error) {
    issue(report.preserved, filename, `Lock owner identity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanReadyFiles(paths: BrcPaths, report: CleanupReport, dryRun: boolean, snapshot: IdentitySnapshot): Promise<void> {
  const directory = paths.runtime;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (errorCode(error) !== 'ENOENT') issue(report.failures, directory, error instanceof Error ? error.message : String(error));
    return;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.ready.json') && !entry.name.endsWith('.ready.json.tmp')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      issue(report.preserved, filename, 'Ready record is not a regular file.');
      continue;
    }
    try {
      const fileInfo = await lstat(filename);
      const file = await readRegularFile(filename);
      if (isStaleFromPreviousBoot(fileInfo.mtimeMs)) {
        await removeFile(paths.root, filename, report, dryRun);
        continue;
      }
      const value = JSON.parse(file.contents) as Record<string, unknown>;
      if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Ready record has no valid PID.');
      if (!snapshotIdentity(snapshot, value.pid)) await removeUnchangedRecord(paths, filename, file.contents, value.pid, report, dryRun);
      else issue(report.preserved, filename, 'Ready record still references a live process.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.preserved, filename, `Ready record is damaged or unverified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function cleanTraefikChildRecord(paths: BrcPaths, report: CleanupReport, dryRun: boolean, snapshot: IdentitySnapshot): Promise<void> {
  const filename = path.join(paths.runtime, 'traefik-child.json');
  let raw: string;
  let value: Record<string, unknown>;
  try {
    const file = await readRegularFile(filename);
    raw = file.contents;
    value = JSON.parse(raw) as Record<string, unknown>;
    if (value.schema !== 1 || typeof value.instanceId !== 'string'
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.instanceId)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !value.createdAt
      || typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath)
      || typeof value.commandLine !== 'string' || !value.commandLine) {
      throw new Error('Traefik child identity record is malformed.');
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') issue(report.preserved, filename, `Child process identity is damaged or unverified: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const current = snapshotIdentity(snapshot, value.pid);
    const samePath = (left: string, right: string) => process.platform === 'win32'
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right);
    if (current && current.createdAt === value.createdAt
      && samePath(current.executablePath, value.executablePath)
      && current.commandLine === value.commandLine) {
      issue(report.preserved, filename, 'Traefik binary process is active.');
      return;
    }
    if ((await readRegularFile(filename)).contents !== raw) {
      issue(report.preserved, filename, 'Traefik child identity record changed during cleanup.');
      return;
    }
    await removeFile(paths.root, filename, report, dryRun);
  } catch (error) {
    issue(report.preserved, filename, `Traefik child identity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanTemporaryFiles(paths: BrcPaths, report: CleanupReport, dryRun: boolean, cutoff: number): Promise<void> {
  const files: LogFile[] = [];
  await collectFiles(paths.root, paths.tmp, report, files);
  for (const file of files) {
    if (file.modifiedAt <= cutoff) await removeFile(paths.root, file.path, report, dryRun);
  }
}

async function collectLogs(paths: BrcPaths, report: CleanupReport): Promise<LogFile[]> {
  const files: LogFile[] = [];
  await collectFiles(paths.root, paths.logs, report, files);
  if (!await safeDirectory(paths.root, paths.config, report)) return files;
  await collectFiles(paths.root, path.join(paths.config, 'logs'), report, files);
  const configLogs = ['claude_tool_call.log', 'tool-history.jsonl'];
  let entries;
  try { entries = await readdir(paths.config, { withFileTypes: true }); } catch (error) {
    if (errorCode(error) !== 'ENOENT') issue(report.failures, paths.config, error instanceof Error ? error.message : String(error));
    return files;
  }
  const allowed = new Set(configLogs);
  for (const entry of entries) {
    if (/^claude_tool_call_.*\.log$/i.test(entry.name)) allowed.add(entry.name);
    if (!allowed.has(entry.name)) continue;
    const filename = path.join(paths.config, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      issue(report.preserved, filename, 'Log path is not a regular file.');
      continue;
    }
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) {
        issue(report.preserved, filename, 'Log path is not a regular file.');
        continue;
      }
      files.push({ path: filename, size: info.size, modifiedAt: info.mtimeMs });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.failures, filename, error instanceof Error ? error.message : String(error));
    }
  }
  return files;
}

async function cleanLogs(
  paths: BrcPaths,
  runtimes: Map<ManagedServiceName, ServiceRuntime>,
  report: CleanupReport,
  dryRun: boolean,
  cutoff: number,
  maxTotalBytes: number,
  precollectedLogs?: LogFile[],
): Promise<void> {
  const files = precollectedLogs ?? await collectLogs(paths, report);
  const active = new Set<string>();
  for (const name of SERVICE_NAMES) {
    if (runtimes.get(name)?.state !== 'inactive') active.add(path.resolve(paths.logs, `${name}.log`));
  }
  if (runtimes.get('agent')?.state !== 'inactive') {
    active.add(path.resolve(paths.config, 'logs', 'fuzzy-search.log'));
    active.add(path.resolve(paths.config, 'claude_tool_call.log'));
    active.add(path.resolve(paths.config, 'tool-history.jsonl'));
  }

  const removed = new Set<string>();
  for (const file of files) {
    if (active.has(path.resolve(file.path))) continue;
    if (file.modifiedAt <= cutoff && await removeFile(paths.root, file.path, report, dryRun)) removed.add(file.path);
  }

  let total = files.reduce((sum, file) => sum + (removed.has(file.path) ? 0 : file.size), 0);
  const oldestFirst = [...files].sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
  for (const file of oldestFirst) {
    if (total <= maxTotalBytes) break;
    if (removed.has(file.path) || active.has(path.resolve(file.path))) continue;
    if (await removeFile(paths.root, file.path, report, dryRun)) {
      removed.add(file.path);
      total -= file.size;
    }
  }
  if (total > maxTotalBytes) issue(report.preserved, paths.logs, `Active logs exceed the ${maxTotalBytes} byte aggregate target.`);
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

async function containsLink(directory: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return filename;
    if (entry.isDirectory()) {
      const nested = await containsLink(filename);
      if (nested) return nested;
    }
  }
  return null;
}

async function removeTree(root: string, directory: string, report: CleanupReport, dryRun: boolean): Promise<void> {
  if (!await safeDirectory(root, directory, report)) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issue(report.preserved, filename, 'Symbolic links and junctions are not traversed.');
    } else if (entry.isDirectory()) await removeTree(root, filename, report, dryRun);
    else if (entry.isFile()) await removeFile(root, filename, report, dryRun);
    else issue(report.preserved, filename, 'Non-file filesystem entry was not inspected.');
  }
  if (!dryRun && await safeDirectory(root, directory, report)) {
    try { await rmdir(directory); } catch (error) { issue(report.failures, directory, error instanceof Error ? error.message : String(error)); }
  }
}

async function cleanTraefikVersions(paths: BrcPaths, runtimes: Map<ManagedServiceName, ServiceRuntime>, report: CleanupReport, dryRun: boolean, cutoff: number): Promise<void> {
  if (!await safeDirectory(paths.root, paths.traefik, report)) return;
  const versionsPath = path.join(paths.traefik, 'versions');
  if (!await safeDirectory(paths.root, versionsPath, report)) return;
  const manifestPath = path.join(paths.traefik, 'versions.json');
  let manifest: VersionManifest;
  try {
    const file = await readRegularFile(manifestPath);
    const value = JSON.parse(file.contents) as Record<string, unknown>;
    if (value.version !== 1 || !validVersion(value.current) || !(value.previous === null || validVersion(value.previous))) {
      throw new Error('Traefik version manifest is malformed.');
    }
    manifest = { version: 1, current: value.current, previous: value.previous };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      const entries = await readdir(versionsPath, { withFileTypes: true });
      if (entries.length === 0) return;
      issue(report.preserved, versionsPath, 'Traefik version metadata is missing; installed versions were preserved.');
    } else {
      issue(report.preserved, manifestPath, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const active = runtimes.get('traefik');
  if (active?.state === 'unknown') {
    issue(report.preserved, versionsPath, 'Traefik process identity is uncertain; installed versions were preserved.');
    return;
  }
  const activeVersion = active?.entrypoint && isWithin(versionsPath, active.entrypoint)
    ? path.relative(versionsPath, active.entrypoint).split(path.sep)[0]
    : undefined;
  let entries;
  try { entries = await readdir(versionsPath, { withFileTypes: true }); } catch (error) {
    issue(report.failures, versionsPath, error instanceof Error ? error.message : String(error));
    return;
  }
  for (const entry of entries) {
    const filename = path.join(versionsPath, entry.name);
    if (entry.isSymbolicLink()) {
      issue(report.preserved, filename, 'Version directory is a link; it was not traversed.');
      continue;
    }
    if (!entry.isDirectory() || entry.name === manifest.current || entry.name === manifest.previous || entry.name === activeVersion) continue;
    let info;
    try { info = await lstat(filename); } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.failures, filename, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (info.mtimeMs > cutoff) continue;
    try {
      const nestedLink = await containsLink(filename);
      if (nestedLink) {
        issue(report.preserved, nestedLink, 'Version contains a link; the version was not traversed.');
        continue;
      }
      await removeTree(paths.root, filename, report, dryRun);
    } catch (error) {
      issue(report.failures, filename, error instanceof Error ? error.message : String(error));
    }
  }
}

interface ProtectedCandidatesCheck {
  hasCandidates: boolean;
  logs?: LogFile[];
}

async function checkProtectedCleanupCandidates(
  paths: BrcPaths, report: CleanupReport, cutoff: number, maxTotalBytes: number,
): Promise<ProtectedCandidatesCheck> {
  if (await safeDirectory(paths.root, paths.runtime, report)) {
    try {
      const entries = await readdir(paths.runtime);
      if (entries.some((name) => SERVICE_NAMES.some((service) => name === `${service}.json`)
          || name === 'traefik-child.json' || name.endsWith('.ready.json') || name.endsWith('.ready.json.tmp'))) return { hasCandidates: true };
    } catch (error) {
      issue(report.failures, paths.runtime, error instanceof Error ? error.message : String(error));
      return { hasCandidates: true };
    }
  }
  const logs = await collectLogs(paths, report);
  const totalLogBytes = logs.reduce((total, file) => total + file.size, 0);
  if (logs.some((file) => file.modifiedAt <= cutoff) || totalLogBytes > maxTotalBytes) return { hasCandidates: true, logs };

  const versionsPath = path.join(paths.traefik, 'versions');
  if (!await safeDirectory(paths.root, versionsPath, report)) return { hasCandidates: false, logs };
  try {
    const versions = await readdir(versionsPath);
    if (versions.length === 0) return { hasCandidates: false, logs };
    let manifest: VersionManifest;
    try {
      const value = JSON.parse((await readRegularFile(path.join(paths.traefik, 'versions.json'))).contents) as Record<string, unknown>;
      if (value.version !== 1 || !validVersion(value.current)
          || !(value.previous === null || validVersion(value.previous))) return { hasCandidates: true, logs };
      manifest = { version: 1, current: value.current, previous: value.previous };
    } catch {
      return { hasCandidates: true, logs };
    }
    return { hasCandidates: versions.some((version) => version !== manifest.current && version !== manifest.previous), logs };
  } catch (error) {
    issue(report.failures, versionsPath, error instanceof Error ? error.message : String(error));
    return { hasCandidates: true, logs };
  }
}


/** Preserve snapshots whenever their process may still be active. */
async function cleanDiagnosticSnapshots(
  paths: BrcPaths,
  report: CleanupReport,
  dryRun: boolean,
  cutoff: number,
): Promise<void> {
  const directory = paths.diagnostics;
  if (!directory) return;
  let info;
  try { info = await lstat(directory); } catch (error) {
    if (errorCode(error) !== 'ENOENT') issue(report.failures, directory, error instanceof Error ? error.message : String(error));
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    issue(report.preserved, directory, 'Diagnostic directory is not a plain directory.');
    return;
  }
  const store = new FileSnapshotStore({ directory });
  const files = await readdir(directory);
  const candidates: { target: string; pid: number; contents: string }[] = [];
  for (const file of files) {
    const match = /^(cli|relay|agent|traefik)-([A-Za-z0-9_.-]{1,128})\.json$/.exec(file);
    if (!match) continue;
    const target = path.join(directory, file);
    let contents: string;
    try { contents = (await readRegularFile(target)).contents; } catch { continue; }
    const result = await store.read(match[1] as 'cli' | 'relay' | 'agent' | 'traefik', match[2]);
    const snapshot = result.snapshot;
    let deadline = snapshot ? Date.parse(snapshot.capturedAt) : Number.NaN;
    if (!Number.isFinite(deadline)) {
      try { deadline = (await lstat(target)).mtimeMs; } catch { continue; }
    }
    if (deadline > cutoff) {
      if (result.state === 'corrupt') issue(report.preserved, target, `Unreadable snapshot (${snapshotStateLabel(result.state)}).`);
      continue;
    }
    if (!snapshot || snapshot.pid <= 0 || snapshot.pid > 0xffffffff) {
      issue(report.preserved, target, 'Cannot determine the snapshot process identity.');
      continue;
    }
    candidates.push({ target, pid: snapshot.pid, contents });
  }
  const identities = new Map<number, ProcessIdentity | null>();
  const eligible = [...new Set(candidates.map((candidate) => candidate.pid))].filter((pid) => {
    try {
      process.kill(pid, 0);
      return process.platform === 'linux' && pid !== process.pid;
    } catch (error) {
      return errorCode(error) === 'ESRCH';
    }
  }).sort((left, right) => left - right);
  if (!eligible.length) return;
  const offset = randomInt(eligible.length);
  const pids = [...eligible.slice(offset), ...eligible.slice(0, offset)].slice(0, 256);
  const signal = AbortSignal.timeout(1_000);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pids.length && !signal.aborted) {
      const batch = pids.slice(next, next + 32);
      next += batch.length;
      try {
        const found = await inspectProcesses(batch, signal);
        for (const [pid, identity] of found) identities.set(pid, identity);
      } catch {
        for (const pid of batch) {
          if (signal.aborted) break;
          try {
            const found = await inspectProcesses([pid], signal);
            if (found.has(pid)) identities.set(pid, found.get(pid) ?? null);
          } catch {
            continue;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  for (const { target, pid, contents } of candidates) {
    if (!identities.has(pid) || identities.get(pid)) {
      issue(report.preserved, target, 'Snapshot process may still be active.');
      continue;
    }
    if (!await processDefinitelyExited(pid)) {
      issue(report.preserved, target, 'Snapshot process may still be active or its state cannot be verified.');
      continue;
    }
    try {
      if ((await readRegularFile(target)).contents !== contents) {
        issue(report.preserved, target, 'Snapshot changed during cleanup.');
        continue;
      }
      const bytes = (await lstat(target)).size;
      if (dryRun) { report.wouldRemove += 1; continue; }
      await unlink(target);
      report.removed += 1;
      report.bytesRemoved += bytes;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.failures, target, error instanceof Error ? error.message : String(error));
    }
  }
}

async function hasExpiredDiagnosticSnapshots(paths: BrcPaths, cutoff: number): Promise<boolean> {
  const directory = paths.diagnostics;
  if (!directory) return false;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const store = new FileSnapshotStore({ directory });
  for (const result of await store.list()) {
    if (result.state === 'current') continue;
    const age = result.snapshot ? Date.parse(result.snapshot.capturedAt) : Number.NaN;
    if (!Number.isFinite(age) || age <= cutoff) return true;
  }
  return false;
}

export async function cleanRuntime(paths: BrcPaths, options: CleanupOptions = {}): Promise<CleanupReport> {
  const report: CleanupReport = { removed: 0, bytesRemoved: 0, wouldRemove: 0, failures: [], preserved: [] };
  const dryRun = options.dryRun === true;
  const settings = options.settings ?? DEFAULT_SETTINGS;
  let rootInfo;
  try { rootInfo = await lstat(paths.root); } catch (error) {
    if (errorCode(error) === 'ENOENT') return report;
    issue(report.failures, paths.root, error instanceof Error ? error.message : String(error));
    return report;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    issue(report.preserved, paths.root, 'BRC data root is not a plain directory; cleanup stopped.');
    return report;
  }

  const cutoff = Date.now() - settings.logs.retentionDays * 24 * 60 * 60 * 1000;
  await cleanTemporaryFiles(paths, report, dryRun, cutoff);
  try {
    await lstat(paths.runtime);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      issue(report.failures, paths.runtime, error instanceof Error ? error.message : String(error));
      return report;
    }
    if (path.relative(path.resolve(paths.root), path.resolve(path.dirname(paths.runtime))) !== '') {
      issue(report.preserved, paths.runtime, 'Runtime directory is not directly inside the BRC data root.');
      return report;
    }
    if (dryRun) {
      issue(report.preserved, paths.runtime, 'Runtime directory is missing; protected cleanup candidates were not evaluated.');
      return report;
    }
    try {
      await mkdir(paths.runtime, { mode: 0o700 });
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') {
        issue(report.failures, paths.runtime, mkdirError instanceof Error ? mkdirError.message : String(mkdirError));
        return report;
      }
    }
  }
  if (!await safeDirectory(paths.root, paths.runtime, report)) return report;

  await cleanLifecycleLock(paths, report, dryRun);
  const diagnosticsCutoff = Date.now() - settings.diagnostics.retentionDays * 24 * 60 * 60 * 1000;
  const candidatesCheck = await checkProtectedCleanupCandidates(paths, report, cutoff, settings.logs.maxTotalMiB * 1024 * 1024);
  if (!candidatesCheck.hasCandidates && !await hasExpiredDiagnosticSnapshots(paths, diagnosticsCutoff)) return report;

  try {
    await new LifecycleLock(paths, { waitMs: settings.runtime.lockWaitMs, pollMs: settings.runtime.lockPollMs }).runExclusive(async () => {
      const snapshot = await runtimeSnapshot(paths, report);
      const runtimes = await inspectServiceRecords(paths, report, dryRun, snapshot);
      await cleanReadyFiles(paths, report, dryRun, snapshot);
      await cleanTraefikChildRecord(paths, report, dryRun, snapshot);
      await cleanLogs(paths, runtimes, report, dryRun, cutoff, settings.logs.maxTotalMiB * 1024 * 1024, candidatesCheck.logs);
      await cleanDiagnosticSnapshots(paths, report, dryRun, diagnosticsCutoff);
      await cleanTraefikVersions(paths, runtimes, report, dryRun, cutoff);
    });
  } catch (error) {
    issue(report.preserved, paths.runtime, `Cleanup could not acquire the lifecycle lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}
export async function removeBrcData(paths: BrcPaths): Promise<CleanupReport> {
  const report: CleanupReport = { removed: 0, bytesRemoved: 0, wouldRemove: 0, failures: [], preserved: [] };
  const root = path.resolve(paths.root);
  let rootInfo;
  try { rootInfo = await lstat(root); } catch (error) {
    if (errorCode(error) === 'ENOENT') return report;
    issue(report.failures, root, error instanceof Error ? error.message : String(error));
    return report;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    issue(report.preserved, root, 'BRC data root is not a plain directory; removal stopped.');
    return report;
  }

  for (const name of ['traefik', 'config', 'data', 'runtime', 'logs', 'diagnostics', 'tmp'] as const) {
    const candidate = paths[name];
    if (!candidate) continue;
    const directory = path.resolve(candidate);
    if (directory !== path.join(root, name)) {
      issue(report.preserved, directory, 'Path does not match the expected BRC data directory.');
      continue;
    }
    await removeTree(root, directory, report, false);
  }

  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (errorCode(error) !== 'ENOENT') issue(report.failures, root, error instanceof Error ? error.message : String(error));
    return report;
  }
  for (const entry of entries) {
    issue(report.preserved, path.join(root, entry.name), 'Unrecognized or protected entry was retained.');
  }
  if (entries.length === 0) {
    try { await rmdir(root); } catch (error) {
      if (errorCode(error) !== 'ENOENT') issue(report.failures, root, error instanceof Error ? error.message : String(error));
    }
  }
  return report;
}
