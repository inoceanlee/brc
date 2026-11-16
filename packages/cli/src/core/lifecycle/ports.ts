export type ManagedServiceName = 'relay' | 'traefik' | 'agent';

export type ServiceState = 'stopped' | 'starting' | 'pairing' | 'running' | 'degraded';

export interface ServiceStatus {
  name: ManagedServiceName;
  state: ServiceState;
  pid: number | null;
  detail: string;
}

export interface ManagedServiceSpec {
  name: ManagedServiceName;
  entrypoint: string;
  workspaceRoot: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface ProcessController {
  start(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<void>;
  stop(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<void>;
  status(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<ServiceStatus>;
  statusMany?(specs: readonly ManagedServiceSpec[]): Promise<ServiceStatus[]>;
}

export interface IdentityRecord {
  pid: number;
  createdAt: string;
  executablePath: string;
  commandLine: string;
}

export interface IdentityPort {
  inspect(pid: number): Promise<IdentityRecord | null>;
  inspectMany(pids: readonly number[]): Promise<(IdentityRecord | null)[]>;
}

export interface ControlHealthPort {
  check(spec: ManagedServiceSpec, signal?: AbortSignal): Promise<{ ready: boolean; detail: string }>;
}

export interface LifecycleLockPort {
  runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
