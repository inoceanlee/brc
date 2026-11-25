import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrcPaths } from '../../config/paths.js';
import { DEFAULT_SETTINGS, HEALTH_REQUEST_TIMEOUT_MS, HEALTH_RETRY_COUNT, IDENTITY_INSPECTION_RETRY_COUNT, type BrcSettings } from '../../config/settings.js';
import { inspectProcess, inspectProcesses, type ProcessIdentity } from './identity.js';
export { inspectProcess } from './identity.js';
export type { ProcessIdentity } from './identity.js';

import type { ControlHealthPort, ManagedServiceName, ManagedServiceSpec, ServiceState, ServiceStatus } from '../../core/lifecycle/ports.js';
import { REUSED_PID_STATUS_DETAIL } from '../../core/lifecycle/policy.js';
export type { ManagedServiceName, ManagedServiceSpec, ServiceState, ServiceStatus } from '../../core/lifecycle/ports.js';

export interface ManagedProcessRecord extends ProcessIdentity {
  version: 1;
  id: string;
  service: ManagedServiceName;
  workspaceRoot: string;
  entrypoint: string;
  controlPort: number;
  controlToken: string;
}

export type ProcessInspector = (pid: number, signal?: AbortSignal) => ProcessIdentity | null | Promise<ProcessIdentity | null>;

export interface ProcessManagerOptions {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  inspectProcess?: ProcessInspector;
}

interface ReadyInfo {
  id: string;
  service: ManagedServiceName;
  pid: number;
  port: number;
}

interface HealthInfo {
  ok: boolean;
  state: 'running' | 'degraded' | 'pairing';
  detail: string;
}

function serviceHealthState(spec: Pick<ManagedServiceSpec, 'name'>, health: Readonly<HealthInfo>): 'running' | 'pairing' | 'degraded' {
  if (spec.name === 'agent' && health.state === 'pairing') return 'pairing';
  return health.ok && health.state === 'running' ? 'running' : 'degraded';
}

function isReadyHealth(spec: Pick<ManagedServiceSpec, 'name'>, health: Readonly<HealthInfo>): boolean {
  return serviceHealthState(spec, health) !== 'degraded';
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const CONTROL_REQUEST_TIMEOUT_MS = HEALTH_REQUEST_TIMEOUT_MS;

function recordPath(paths: BrcPaths, name: ManagedServiceName): string {
  return path.join(paths.runtime, `${name}.json`);
}

function samePath(left: string, right: string): boolean {
  const canonical = (filename: string) => {
    const resolved = path.resolve(filename);
    try { return realpathSync.native(resolved); }
    catch { return resolved; }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeCommandLine(value: string): string {
  const normalized = process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  return normalized;
}

function isValidSpec(spec: ManagedServiceSpec): void {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`Invalid managed service name: ${spec.name}`);
  if (!path.isAbsolute(spec.entrypoint) || !path.isAbsolute(spec.workspaceRoot) || !path.isAbsolute(spec.cwd)) {
    throw new Error(`${spec.name} service paths must be absolute.`);
  }
  if (!isWithin(spec.workspaceRoot, spec.entrypoint) || (!samePath(spec.workspaceRoot, spec.cwd) && !isWithin(spec.workspaceRoot, spec.cwd))) {
    throw new Error(`${spec.name} entrypoint and working directory must belong to its workspace.`);
  }
}

function matchesRecordedInstallation(record: ManagedProcessRecord, spec: ManagedServiceSpec): boolean {
  if (!isWithin(record.workspaceRoot, record.entrypoint) || !isWithin(spec.workspaceRoot, spec.entrypoint)) return false;
  if (samePath(record.workspaceRoot, spec.workspaceRoot) && samePath(record.entrypoint, spec.entrypoint)) return true;
  const previousRelative = path.relative(record.workspaceRoot, record.entrypoint);
  const currentRelative = path.relative(spec.workspaceRoot, spec.entrypoint);
  if (process.platform === 'win32') return previousRelative.toLowerCase() === currentRelative.toLowerCase();
  return previousRelative === currentRelative;
}

function sameIdentity(record: ManagedProcessRecord, current: ProcessIdentity, spec: ManagedServiceSpec): boolean {
  const commandLine = normalizeCommandLine(current.commandLine);
  const storedCommand = normalizeCommandLine(record.commandLine);
  const expectedEntry = normalizeCommandLine(path.resolve(record.entrypoint));
  const managedId = `--brc-managed-id=${record.id}`;
  const normalizedId = process.platform === 'win32' ? managedId.toLowerCase() : managedId;
  return current.pid === record.pid
    && current.createdAt === record.createdAt
    && samePath(current.executablePath, record.executablePath)
    && samePath(current.executablePath, process.execPath)
    && matchesRecordedInstallation(record, spec)
    && commandLine === storedCommand
    && storedCommand.includes(expectedEntry)
    && commandLine.includes(normalizedId);
}

function confirmedReused(
  record: ManagedProcessRecord,
  current: ProcessIdentity,
  previousBoot: boolean,
): boolean {
  if (!previousBoot || current.pid !== record.pid || current.createdAt === record.createdAt) return false;
  const managedId = `--brc-managed-id=${record.id}`;
  const normalizedId = process.platform === 'win32' ? managedId.toLowerCase() : managedId;
  const storedCommand = normalizeCommandLine(record.commandLine);
  const commandLine = normalizeCommandLine(current.commandLine);
  return storedCommand.includes(normalizedId)
    && storedCommand.includes(normalizeCommandLine(path.resolve(record.entrypoint)))
    && commandLine !== storedCommand
    && !commandLine.includes(normalizedId)
    && !samePath(current.executablePath, process.execPath);
}

function parseProcessRecord(value: unknown, spec: ManagedServiceSpec): ManagedProcessRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${spec.name} process record is malformed; refusing process control.`);
  }
  if (!('version' in value) || !('service' in value) || !('id' in value) || !('pid' in value)
      || !('createdAt' in value) || !('executablePath' in value) || !('commandLine' in value)
      || !('workspaceRoot' in value) || !('entrypoint' in value) || !('controlPort' in value)
      || !('controlToken' in value)) {
    throw new Error(`${spec.name} process record is incomplete; refusing process control.`);
  }
  if (value.version !== 1 || (value.service !== 'relay' && value.service !== 'traefik' && value.service !== 'agent')
      || value.service !== spec.name || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !value.createdAt
      || typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath)
      || typeof value.commandLine !== 'string'
      || typeof value.workspaceRoot !== 'string' || !path.isAbsolute(value.workspaceRoot)
      || typeof value.entrypoint !== 'string' || !path.isAbsolute(value.entrypoint)
      || typeof value.controlPort !== 'number' || !Number.isInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535
      || typeof value.controlToken !== 'string' || !/^[0-9a-f]{64}$/i.test(value.controlToken)) {
    throw new Error(`${spec.name} process record is malformed; refusing process control.`);
  }
  return {
    version: 1,
    id: value.id,
    service: value.service,
    pid: value.pid,
    createdAt: value.createdAt,
    executablePath: value.executablePath,
    commandLine: value.commandLine,
    workspaceRoot: value.workspaceRoot,
    entrypoint: value.entrypoint,
    controlPort: value.controlPort,
    controlToken: value.controlToken,
  };
}

function parseReady(value: unknown, spec: ManagedServiceSpec, id: string, pid: number): ReadyInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('id' in value) || !('service' in value) || !('pid' in value) || !('port' in value)) return null;
  if (typeof value.id !== 'string' || value.id !== id
      || (value.service !== 'relay' && value.service !== 'traefik' && value.service !== 'agent')
      || value.service !== spec.name || value.pid !== pid
      || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  return { id: value.id, service: value.service, pid: value.pid, port: value.port };
}

function processErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

export function isStaleFromPreviousBoot(mtimeMs: number): boolean {
  const bootTimeMs = Date.now() - (os.uptime() * 1000);
  return mtimeMs < (bootTimeMs - 5000);
}
export async function processDefinitelyExited(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const state = close >= 0 ? stat.slice(close + 2, close + 4) : '';
        return state === 'Z ' || state === 'X ' || state === 'x ';
      } catch {
        return false;
      }
    }
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}



export class ProcessManager implements ControlHealthPort {
  private startupTimeoutMs: number;
  private shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly inspect: ProcessInspector;
  private readonly customInspector: boolean;
  private readonly starting = new Map<ManagedServiceName, number | null>();
  private readonly previousBootRecords = new WeakSet<ManagedProcessRecord>();

  constructor(private readonly paths: BrcPaths, options: ProcessManagerOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SETTINGS.runtime.startupTimeoutMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SETTINGS.runtime.shutdownTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.inspect = options.inspectProcess ?? inspectProcess;
    this.customInspector = options.inspectProcess !== undefined;
  }
  updateRuntimeSettings(settings: Readonly<Pick<BrcSettings['runtime'], 'startupTimeoutMs' | 'shutdownTimeoutMs'>>): void {
    this.startupTimeoutMs = settings.startupTimeoutMs;
    this.shutdownTimeoutMs = settings.shutdownTimeoutMs;
  }

  async start(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    isValidSpec(spec);
    if (this.starting.has(spec.name)) throw new Error(`${spec.name} is already starting.`);
    this.starting.set(spec.name, null);
    let child: ChildProcess | undefined;
    let record: ManagedProcessRecord | undefined;
    let readyRemoved = false;
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const readyFile = path.join(this.paths.runtime, `${spec.name}.${id}.ready.json`);

    try {
      await mkdir(this.paths.runtime, { recursive: true });
      signal?.throwIfAborted();
      const current = await this.readRecord(spec);
      if (current) {
        const identity = await this.inspect(current.pid);
        if (!identity) {
          if (!await processDefinitelyExited(current.pid)) throw Object.assign(new Error(`${spec.name} process identity cannot be verified; refusing to start.`), { exitCode: 5 });
          await this.removeRecord(spec.name);
        } else if (confirmedReused(current, identity, this.previousBootRecords.has(current))) {
          await this.removeRecord(spec.name);
        } else if (!sameIdentity(current, identity, spec)) {
          throw Object.assign(new Error(`${spec.name} process identity cannot be verified; refusing to start.`), { exitCode: 5 });
        } else {
          const health = await this.readHealth(current, Infinity, signal);
          if (isReadyHealth(spec, health)) return;
          throw new Error(`${spec.name} is already managed but unhealthy: ${health.detail}`);
        }
      }

      const environment = {
        ...process.env,
        ...spec.env,
        BRC_CONTROL_TOKEN: token,
        BRC_CONTROL_READY_FILE: readyFile,
        BRC_MANAGED_ID: id,
        BRC_MANAGED_SERVICE: spec.name,
      };
      signal?.throwIfAborted();
      child = spawn(process.execPath, [spec.entrypoint, ...(spec.args ?? []), `--brc-managed-id=${id}`], {
        cwd: spec.cwd,
        env: environment,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        signal,
      });
      child.once('error', () => undefined);
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      child.on('exit', (code, signal) => { exit = { code, signal }; });
      await once(child, 'spawn');
      if (!child.pid) throw new Error(`${spec.name} process did not receive a PID.`);
      child.unref();
      this.starting.set(spec.name, child.pid);
      const deadline = Date.now() + (spec.startupTimeoutMs ?? this.startupTimeoutMs);

      const ready = await this.waitForReady(child, spec, readyFile, id, () => exit, deadline, signal);
      const identity = await this.inspect(child.pid);
      if (!identity || !this.isCandidateIdentity(identity, spec, id)) {
        throw new Error(`${spec.name} process identity could not be verified after startup.`);
      }
      record = {
        version: 1,
        id,
        service: spec.name,
        pid: identity.pid,
        createdAt: identity.createdAt,
        executablePath: identity.executablePath,
        commandLine: identity.commandLine,
        workspaceRoot: path.resolve(spec.workspaceRoot),
        entrypoint: path.resolve(spec.entrypoint),
        controlPort: ready.port,
        controlToken: token,
      };
      await this.writeRecord(record);
      await this.waitForHealthy(record, spec, child, () => exit, deadline, signal);
      await this.removeReadyFile(readyFile);
      readyRemoved = true;
      if (exit || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${spec.name} exited during startup.`);
      }
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (record) await this.stopRecord(spec, record, true, undefined, true);
        else if (child?.pid) await this.stopUnrecorded(spec, child.pid, id, token, readyFile);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError) {
        const reason = signal?.aborted ? signal.reason : error;
        const combined = new AggregateError([reason, cleanupError], `${spec.name} startup failed: ${processErrorMessage(reason)}; rollback reported: ${processErrorMessage(cleanupError)}`);
        const exitCode = reason && typeof reason === 'object' && 'exitCode' in reason ? reason.exitCode : undefined;
        throw Object.assign(combined, { exitCode });
      }
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      this.starting.delete(spec.name);
      if (!readyRemoved) await this.removeReadyFile(readyFile);
    }
  }

  async stop(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    isValidSpec(spec);
    const record = await this.readRecord(spec);
    if (!record) return;
    await this.stopRecord(spec, record, true, signal);
  }

  async check(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<{ ready: boolean; detail: string }> {
    signal?.throwIfAborted();
    isValidSpec(spec);
    const record = await this.readRecord(spec);
    if (!record) return { ready: false, detail: 'No managed process record is available.' };
    try {
      const health = await this.readHealth(record, Date.now() + this.startupTimeoutMs, signal);
      const ready = isReadyHealth(spec, health);
      return { ready, detail: health.detail };
    } catch (error) {
      signal?.throwIfAborted();
      return { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<ServiceStatus> {
    signal?.throwIfAborted();
    if (this.starting.has(spec.name)) {
      return { name: spec.name, state: 'starting', pid: this.starting.get(spec.name) ?? null, detail: 'Service startup is in progress.' };
    }
    let record: ManagedProcessRecord | null;
    try {
      record = await this.readRecord(spec);
    } catch (error) {
      signal?.throwIfAborted();
      return { name: spec.name, state: 'degraded', pid: null, detail: processErrorMessage(error) };
    }
    if (!record) return { name: spec.name, state: 'stopped', pid: null, detail: 'No managed process record.' };

    let identity: ProcessIdentity | null;
    try {
      identity = await this.inspectForStatus(record.pid, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: `Cannot verify process identity: ${processErrorMessage(error)}` };
    }
    if (!identity) return await processDefinitelyExited(record.pid)
      ? { name: spec.name, state: 'stopped', pid: null, detail: 'Recorded process has exited.' }
      : { name: spec.name, state: 'degraded', pid: record.pid, detail: 'Cannot verify process identity; refusing process control.' };
    if (confirmedReused(record, identity, this.previousBootRecords.has(record))) {
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: REUSED_PID_STATUS_DETAIL };
    }
    if (!sameIdentity(record, identity, spec)) {
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: 'Process identity changed; refusing process control.' };
    }

    try {
      const health = await this.readHealth(record, Infinity, signal);
      return {
        name: spec.name,
        state: serviceHealthState(spec, health),
        pid: record.pid,
        detail: health.detail,
      };
    } catch (error) {
      signal?.throwIfAborted();
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: `Health check failed: ${processErrorMessage(error)}` };
    }
  }

  async statusMany(specs: readonly ManagedServiceSpec[]): Promise<ServiceStatus[]> {
    if (this.customInspector) return Promise.all(specs.map((spec) => this.status(spec)));
    const entries = await Promise.all(specs.map(async (spec): Promise<{ spec: ManagedServiceSpec; record?: ManagedProcessRecord; status?: ServiceStatus }> => {
      if (this.starting.has(spec.name)) {
        return { spec, status: { name: spec.name, state: 'starting', pid: this.starting.get(spec.name) ?? null, detail: 'Service startup is in progress.' } };
      }
      try {
        const record = await this.readRecord(spec);
        return record ? { spec, record } : { spec, status: { name: spec.name, state: 'stopped', pid: null, detail: 'No managed process record.' } };
      } catch (error) {
        return { spec, status: { name: spec.name, state: 'degraded', pid: null, detail: processErrorMessage(error) } };
      }
    }));
    const pids = entries.flatMap(({ record }) => record ? [record.pid] : []);
    let identities = new Map<number, ProcessIdentity | null>();
    let inspectionError: unknown;
    if (pids.length) {
      for (let attempt = 0; attempt <= IDENTITY_INSPECTION_RETRY_COUNT; attempt++) {
        try {
          identities = await inspectProcesses(pids);
          inspectionError = undefined;
          break;
        } catch (error) {
          inspectionError = error;
          if (attempt < IDENTITY_INSPECTION_RETRY_COUNT) await sleep(this.pollIntervalMs);
        }
      }
    }
    if (inspectionError !== undefined) return Promise.all(specs.map((spec) => this.status(spec)));
    return Promise.all(entries.map(async ({ spec, record, status }): Promise<ServiceStatus> => {
      if (status) return status;
      if (!record) throw new Error('Missing process record.');
      const identity = identities.get(record.pid);
      if (!identity) return await processDefinitelyExited(record.pid)
        ? { name: spec.name, state: 'stopped', pid: null, detail: 'Recorded process has exited.' }
        : { name: spec.name, state: 'degraded', pid: record.pid, detail: 'Cannot verify process identity; refusing process control.' };
      if (confirmedReused(record, identity, this.previousBootRecords.has(record))) return { name: spec.name, state: 'degraded', pid: record.pid, detail: REUSED_PID_STATUS_DETAIL };
      if (!sameIdentity(record, identity, spec)) return { name: spec.name, state: 'degraded', pid: record.pid, detail: 'Process identity changed; refusing process control.' };
      try {
        const health = await this.readHealth(record);
        return { name: spec.name, state: serviceHealthState(spec, health), pid: record.pid, detail: health.detail };
      } catch (error) {
        return { name: spec.name, state: 'degraded', pid: record.pid, detail: `Health check failed: ${processErrorMessage(error)}` };
      }
    }));
  }

  private async inspectForStatus(pid: number, signal?: AbortSignal): Promise<ProcessIdentity | null> {
    for (let attempt = 0; attempt <= IDENTITY_INSPECTION_RETRY_COUNT; attempt++) {
      try {
        return await this.inspect(pid, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === IDENTITY_INSPECTION_RETRY_COUNT) throw error;
        await sleep(this.pollIntervalMs, undefined, { signal });
      }
    }
    throw new Error('Process identity inspection exhausted all retries.');
  }

  private async waitForReady(
    child: ChildProcess,
    spec: ManagedServiceSpec,
    readyFile: string,
    id: string,
    getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ReadyInfo> {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const exit = getExit();
      if (exit) throw new Error(`${spec.name} exited before readiness (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}).`);
      if (!child.pid) throw new Error(`${spec.name} did not receive a PID.`);
      try {
        const value = JSON.parse(await readFile(readyFile, 'utf8')) as unknown;
        const ready = parseReady(value, spec, id, child.pid);
        if (ready) return ready;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    throw new Error(`${spec.name} did not publish a ready control endpoint before timeout.`);
  }

  private async waitForHealthy(
    record: ManagedProcessRecord,
    spec: ManagedServiceSpec,
    child: ChildProcess,
    getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let detail = 'Health endpoint did not report ready.';
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (getExit() || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${spec.name} exited during startup.`);
      }
      try {
        const health = await this.readHealth(record, deadline, signal);
        if (getExit() || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`${spec.name} exited during startup.`);
        }
        detail = health.detail;
        if (isReadyHealth(spec, health)) return;
      } catch (error) {
        signal?.throwIfAborted();
        if (getExit() || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`${spec.name} exited during startup.`, { cause: error });
        }
        detail = processErrorMessage(error);
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    throw new Error(`${spec.name} did not become healthy: ${detail}`);
  }

  private async readHealth(record: ManagedProcessRecord, deadline = Infinity, signal?: AbortSignal): Promise<HealthInfo> {
    signal?.throwIfAborted();
    if (record.controlPort < 1) throw new Error('Missing managed control port.');
    for (let attempt = 0; attempt <= HEALTH_RETRY_COUNT; attempt++) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Health request deadline expired.');
        const attemptTimeout = attempt === 0 ? 500 : CONTROL_REQUEST_TIMEOUT_MS;
        return await this.requestHealth(record, Math.min(attemptTimeout, remaining), signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === HEALTH_RETRY_COUNT || Date.now() >= deadline) throw error;
        await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
      }
    }
    throw new Error('Health request exhausted all retries.');
  }

  private async requestHealth(record: ManagedProcessRecord, timeoutMs: number, signal?: AbortSignal): Promise<HealthInfo> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`http://127.0.0.1:${record.controlPort}/health`, {
      headers: { authorization: `Bearer ${record.controlToken}` },
      signal: requestSignal,
    });
    const health = await response.json() as Partial<HealthInfo>;
    return {
      ok: response.ok && health.ok === true,
      state: response.ok && health.state === 'pairing' ? 'pairing' : response.ok && health.state === 'running' ? 'running' : 'degraded',
      detail: typeof health.detail === 'string' ? health.detail : `Control endpoint returned HTTP ${response.status}.`,
    };
  }

  private async stopRecord(spec: ManagedServiceSpec, record: ManagedProcessRecord, removeRecord: boolean, signal?: AbortSignal, rollback = false): Promise<void> {
    signal?.throwIfAborted();
    let current: ProcessIdentity | null;
    try {
      current = await this.inspect(record.pid, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error(`${spec.name} process identity cannot be verified: ${processErrorMessage(error)}`, { cause: error }), { exitCode: 5 });
    }
    signal?.throwIfAborted();
    if (!current) {
      if (!await processDefinitelyExited(record.pid)) throw Object.assign(new Error(`${spec.name} process identity cannot be verified; refusing to stop PID ${record.pid}.`), { exitCode: 5 });
      if (removeRecord) await this.removeRecord(spec.name);
      return;
    }
    if (confirmedReused(record, current, this.previousBootRecords.has(record))) {
      if (removeRecord) await this.removeRecord(spec.name);
      return;
    }
    if (!sameIdentity(record, current, spec)) throw Object.assign(new Error(`${spec.name} process identity changed; refusing to stop PID ${record.pid}.`), { exitCode: 5 });

    const deadline = Date.now() + this.shutdownTimeoutMs;
    const requestDeadline = deadline + HEALTH_REQUEST_TIMEOUT_MS;
    let shutdownError: Error | undefined;
    const checkCancellation = () => {
      if (!signal?.aborted) return;
      if (shutdownError) {
        throw new AggregateError([shutdownError, signal.reason], `${shutdownError.message}; shutdown cancelled: ${processErrorMessage(signal.reason)}`);
      }
      signal.throwIfAborted();
    };
    if (record.controlPort > 0) {
      try {
        const timeout = AbortSignal.timeout(Math.max(1, requestDeadline - Date.now()));
        const response = await fetch(`http://127.0.0.1:${record.controlPort}/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${record.controlToken}` },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        let body: { ok?: unknown; error?: { message?: unknown } };
        try { body = await response.json() as typeof body; }
        catch (error) { throw new Error(`${spec.name} shutdown returned HTTP ${response.status} with an invalid response: ${processErrorMessage(error)}`, { cause: error }); }
        if (response.status !== 200 || body?.ok !== true) {
          const detail = typeof body?.error?.message === 'string' ? body.error.message : 'invalid shutdown response';
          throw new Error(`${spec.name} shutdown failed (HTTP ${response.status}): ${detail}`);
        }
      } catch (error) {
        checkCancellation();
        shutdownError = new Error(`${spec.name} shutdown was not confirmed: ${processErrorMessage(error)}`, { cause: error });
      }
    } else {
      if (removeRecord) shutdownError = new Error(`${spec.name} has no managed shutdown endpoint.`);
    }

    checkCancellation();
    try {
    if (!await this.waitForExit(record, spec, Math.max(0, deadline - Date.now()), signal)) {
      let latest: ProcessIdentity | null;
      try { latest = await this.inspect(record.pid, signal); }
      catch (error) {
        checkCancellation();
        throw Object.assign(new Error(`${spec.name} process identity cannot be verified: ${processErrorMessage(error)}`, { cause: error }), { exitCode: 5 });
      }
      checkCancellation();
      if (!latest) {
        if (!await processDefinitelyExited(record.pid)) throw Object.assign(new Error(`${spec.name} process identity cannot be verified; refusing to stop PID ${record.pid}.`), { exitCode: 5 });
        if (removeRecord) await this.removeRecord(spec.name);
        if (shutdownError) throw shutdownError;
        return;
      }
      if (!sameIdentity(record, latest, spec)) throw Object.assign(new Error(`${spec.name} process identity changed before forced stop; refusing PID ${record.pid}.`), { exitCode: 5 });
      checkCancellation();
      let forced = true;
      try {
        if (process.platform === 'win32') process.kill(record.pid);
        else process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error;
        forced = false;
      }
      if (forced && !rollback) {
        shutdownError = new Error(`${spec.name} forced termination signal was sent; process exit is not yet confirmed${shutdownError ? `: ${shutdownError.message}` : '.'}`, { cause: shutdownError });
      }
      if (!await this.waitForExit(record, spec, this.shutdownTimeoutMs, signal)) {
        throw new Error(`${spec.name} process ${record.pid} exit was not confirmed after targeted forced stop.`);
      }
      if (forced && !rollback) {
        shutdownError = new Error(`${spec.name} was forcibly stopped after the shutdown deadline${shutdownError?.cause ? `: ${processErrorMessage(shutdownError.cause)}` : '.'}`, { cause: shutdownError?.cause });
      }
      if (forced && rollback && record.controlPort === 0) shutdownError = undefined;
    }
    } catch (error) {
      checkCancellation();
      if (shutdownError && error !== shutdownError) {
        const combined = new AggregateError([shutdownError, error], `${shutdownError.message}; ${processErrorMessage(error)}`);
        const exitCode = error && typeof error === 'object' && 'exitCode' in error ? error.exitCode : undefined;
        throw Object.assign(combined, { exitCode });
      }
      throw error;
    }

    if (removeRecord) await this.removeRecord(spec.name);
    if (shutdownError) throw shutdownError;
  }

  private async waitForExit(record: ManagedProcessRecord, spec: ManagedServiceSpec, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let current: ProcessIdentity | null;
      try { current = await this.inspect(record.pid, signal); }
      catch (error) {
        signal?.throwIfAborted();
        throw Object.assign(new Error(`${spec.name} process identity cannot be verified: ${processErrorMessage(error)}`, { cause: error }), { exitCode: 5 });
      }
      signal?.throwIfAborted();
      if (!current) {
        if (await processDefinitelyExited(record.pid)) return true;
        if (this.customInspector || Date.now() + this.pollIntervalMs >= deadline) {
          throw Object.assign(new Error(`${spec.name} process identity cannot be verified; refusing process control.`), { exitCode: 5 });
        }
      } else if (!sameIdentity(record, current, spec)) {
        throw Object.assign(new Error(`${spec.name} PID ${record.pid} no longer matches its recorded identity.`), { exitCode: 5 });
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    signal?.throwIfAborted();
    return false;
  }

  private async stopUnrecorded(
    spec: ManagedServiceSpec,
    pid: number,
    id: string,
    token: string,
    readyFile: string,
  ): Promise<void> {
    const identity = await this.inspect(pid);
    if (!identity) return;
    if (!this.isCandidateIdentity(identity, spec, id)) {
      throw new Error(`${spec.name} startup process identity could not be verified; refusing to stop PID ${pid}.`);
    }
    let ready: ReadyInfo | null = null;
    try {
      ready = parseReady(JSON.parse(await readFile(readyFile, 'utf8')) as unknown, spec, id, pid);
    } catch {}
    const record: ManagedProcessRecord = {
      version: 1,
      id,
      service: spec.name,
      pid: identity.pid,
      createdAt: identity.createdAt,
      executablePath: identity.executablePath,
      commandLine: identity.commandLine,
      workspaceRoot: path.resolve(spec.workspaceRoot),
      entrypoint: path.resolve(spec.entrypoint),
      controlPort: ready?.port ?? 0,
      controlToken: token,
    };
    await this.stopRecord(spec, record, false, undefined, true);
  }

  private isCandidateIdentity(identity: ProcessIdentity, spec: ManagedServiceSpec, id: string): boolean {
    const commandLine = normalizeCommandLine(identity.commandLine);
    const entrypoint = normalizeCommandLine(path.resolve(spec.entrypoint));
    const managedId = `--brc-managed-id=${id}`;
    const normalizedId = process.platform === 'win32' ? managedId.toLowerCase() : managedId;
    return samePath(identity.executablePath, process.execPath)
      && isWithin(spec.workspaceRoot, spec.entrypoint)
      && commandLine.includes(entrypoint)
      && commandLine.includes(normalizedId);
  }

  private async readRecord(spec: ManagedServiceSpec): Promise<ManagedProcessRecord | null> {
    const filename = recordPath(this.paths, spec.name);
    try {
      const record = parseProcessRecord(JSON.parse(await readFile(filename, 'utf8')), spec);
      if (isStaleFromPreviousBoot((await stat(filename)).mtimeMs)) this.previousBootRecords.add(record);
      if (!matchesRecordedInstallation(record, spec)) {
        throw new Error(`${spec.name} process record belongs to another workspace; refusing process control.`);
      }
      return record;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw Object.assign(new Error(`${spec.name} process record cannot be verified: ${processErrorMessage(error)}`, { cause: error }), { exitCode: 5 });
    }
  }
  private async writeRecord(record: ManagedProcessRecord): Promise<void> {
    const filename = recordPath(this.paths, record.service);
    const temporaryFile = `${filename}.${record.id}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryFile, filename);
  }

  private async removeRecord(name: ManagedServiceName): Promise<void> {
    try {
      await unlink(recordPath(this.paths, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async removeReadyFile(filename: string): Promise<void> {
    try {
      await unlink(filename);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
