import type { TraceSink } from 'brc-shared';
import type { BrcPaths } from '../../config/paths.js';
import type { ControlHealthPort, LifecycleLockPort, ManagedServiceSpec, ProcessController, ServiceStatus } from './ports.js';
import { isActive, isStartable } from './policy.js';

export interface LockedServiceOperations {
  start(known?: readonly ServiceStatus[], signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
  restart(signal?: AbortSignal): Promise<void>;
}

export class ServiceManager {
  private services: ManagedServiceSpec[];
  private readonly lockedOperations: LockedServiceOperations = {
    start: (known, signal) => this.startUnlocked(known, signal),
    stop: (signal) => this.stopUnlocked(signal),
    restart: async (signal) => {
      await this.stopUnlocked(signal);
      await this.startUnlocked(undefined, signal);
    },
  };

  constructor(
    paths: BrcPaths,
    services: ManagedServiceSpec[],
    private readonly processes: ProcessController,
    private readonly healthCheck: ControlHealthPort,
    private readonly lifecycleLock: LifecycleLockPort,
    private readonly refreshServices?: () => Promise<ManagedServiceSpec[]>,
    private readonly trace?: TraceSink,
  ) {
    if (!processes || !healthCheck || typeof healthCheck.check !== 'function'
      || !lifecycleLock || typeof lifecycleLock.runExclusive !== 'function') {
      throw new Error('ServiceManager requires injected process, health-check, and lifecycle-lock adapters.');
    }
    this.validateServices(services);
    this.services = services;
  }

  start(signal?: AbortSignal): Promise<void> {
    return this.withLock((services) => services.start(undefined, signal), signal);
  }

  stop(signal?: AbortSignal): Promise<void> {
    return this.withLock((services) => services.stop(signal), signal);
  }

  restart(signal?: AbortSignal): Promise<void> {
    return this.withLock((services) => services.restart(signal), signal);
  }

  withLock<T>(operation: (services: LockedServiceOperations) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.lifecycleLock.runExclusive(async () => {
      signal?.throwIfAborted();
      const refreshed = await this.refreshServices?.();
      if (refreshed) {
        this.validateServices(refreshed);
        this.services = refreshed;
      }
      signal?.throwIfAborted();
      return operation(this.lockedOperations);
    }, signal);
  }

  status(): Promise<ServiceStatus[]> {
    return this.processes.statusMany?.(this.services)
      ?? Promise.all(this.services.map((service) => this.processes.status(service)));
  }
  private validateServices(services: ManagedServiceSpec[]): void {
    const names = new Set<ManagedServiceSpec['name']>();
    for (const service of services) {
      if (names.has(service.name)) throw new Error(`Duplicate managed service: ${service.name}`);
      names.add(service.name);
    }
  }

  private stage<T>(stage: string, service: string, operation: () => Promise<T>): Promise<T> {
    return this.trace ? this.trace.span(stage, operation, service) : operation();
  }

  private async startUnlocked(known?: readonly ServiceStatus[], signal?: AbortSignal): Promise<void> {
    const started: ManagedServiceSpec[] = [];
    const knownByName = new Map((known ?? []).map((status) => [status.name, status]));
    try {
      for (const service of this.services) {
        signal?.throwIfAborted();
        const prechecked = knownByName.get(service.name);
        const current = prechecked ?? await this.stage('precheck', service.name, () => this.processes.status(service));
        if (isActive(current) || (service.name === 'agent' && current.state === 'pairing')) continue;
        if (!isStartable(current)) {
          throw new Error(`Cannot start ${service.name}: ${current.detail}`);
        }
        await this.stage('spawn-ready', service.name, () => this.processes.start(service, signal));
        started.push(service);
        const health = await this.stage('control-health', service.name, () => this.healthCheck.check(service, signal));
        if (!health.ready) throw new Error(`${service.name} failed its control health check: ${health.detail}`);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const service of started.reverse()) {
        try {
          await this.processes.stop(service);
        } catch (failure) {
          rollbackErrors.push(failure);
        }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Service startup failed and rollback was incomplete.');
      throw error;
    }
  }

  private async stopUnlocked(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const failures: Error[] = [];
    for (const service of [...this.services].reverse()) {
      signal?.throwIfAborted();
      try {
        const current = await this.processes.status(service);
        signal?.throwIfAborted();
        if (current.state !== 'stopped') await this.processes.stop(service, signal);
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    signal?.throwIfAborted();
    if (failures.length) throw new AggregateError(failures, 'One or more managed services could not be stopped safely.');
  }
}
