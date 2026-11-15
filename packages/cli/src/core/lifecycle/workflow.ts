import type { TraceSink } from 'brc-shared';
import type { BrcPaths } from '../../config/paths.js';
import { LifecycleLock } from '../../adapters/storage/lock.js';
import { ProcessManager } from '../../adapters/process/controller.js';
import type { ManagedServiceSpec, ProcessController, ServiceStatus } from './ports.js';
import { isActive, isStartable, startRejection, shouldWriteTraefikConfig } from './policy.js';

export interface LockedServiceOperations {
  start(known?: readonly ServiceStatus[]): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export class ServiceManager {
  private services: ManagedServiceSpec[];
  private readonly lockedOperations: LockedServiceOperations = {
    start: () => this.startUnlocked(),
    stop: () => this.stopUnlocked(),
    restart: async () => {
      await this.stopUnlocked();
      await this.startUnlocked();
    },
  };

  constructor(
    paths: BrcPaths,
    services: ManagedServiceSpec[],
    private readonly processes: ProcessController = new ProcessManager(paths),
    private readonly lifecycleLock: LifecycleLock = new LifecycleLock(paths),
    private readonly refreshServices?: () => Promise<ManagedServiceSpec[]>,
    private readonly trace?: TraceSink,
  ) {
    this.validateServices(services);
    this.services = services;
  }

  start(): Promise<void> {
    return this.withLock((services) => services.start());
  }

  stop(): Promise<void> {
    return this.withLock((services) => services.stop());
  }

  restart(): Promise<void> {
    return this.withLock((services) => services.restart());
  }

  withLock<T>(operation: (services: LockedServiceOperations) => Promise<T>): Promise<T> {
    return this.lifecycleLock.runExclusive(async () => {
      const refreshed = await this.refreshServices?.();
      if (refreshed) {
        this.validateServices(refreshed);
        this.services = refreshed;
      }
      return operation(this.lockedOperations);
    });
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

  private async startUnlocked(known?: readonly ServiceStatus[]): Promise<void> {
    const started: ManagedServiceSpec[] = [];
    const knownByName = new Map((known ?? []).map((status) => [status.name, status]));
    try {
      for (const service of this.services) {
        const prechecked = knownByName.get(service.name);
        const current = prechecked ?? await this.stage('precheck', service.name, () => this.processes.status(service));
        if (isActive(current) || (service.name === 'agent' && current.state === 'pairing')) continue;
        if (!isStartable(current)) {
          throw new Error(`Cannot start ${service.name}: ${current.detail}`);
        }
        await this.stage('spawn-ready', service.name, () => this.processes.start(service));
        started.push(service);
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

  private async stopUnlocked(): Promise<void> {
    const failures: Error[] = [];
    for (const service of [...this.services].reverse()) {
      try {
        const current = await this.processes.status(service);
        if (current.state !== 'stopped') await this.processes.stop(service);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'One or more managed services could not be stopped safely.');
  }
}
