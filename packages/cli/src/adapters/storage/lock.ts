import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrcPaths } from '../../config/paths.js';
import { DEFAULT_SETTINGS } from '../../config/settings.js';
import { inspectProcess, type ProcessIdentity } from '../process/identity.js';
import { LockStore, type LockOwner } from './lock-store.js';

export interface LockWaitOptions { waitMs?: number; pollMs?: number }

export class LifecycleLock {
  private static ownIdentity: Promise<ProcessIdentity> | undefined;
  private static inspectSelf(): Promise<ProcessIdentity> {
    this.ownIdentity ??= inspectProcess(process.pid).then((identity) => {
      if (!identity) throw new Error('Cannot verify the CLI process identity for lifecycle locking.');
      return identity;
    }).catch((error: unknown) => {
      this.ownIdentity = undefined;
      throw error;
    });
    return this.ownIdentity;
  }

  private queue: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<LifecycleLock>();
  private readonly store: LockStore;
  private readonly paths: BrcPaths;
  private waitMs: number;
  private pollMs: number;

  constructor(paths: BrcPaths, options: LockWaitOptions = {}) {
    this.paths = paths;
    this.store = new LockStore(paths);
    this.waitMs = options.waitMs ?? DEFAULT_SETTINGS.runtime.lockWaitMs;
    this.pollMs = options.pollMs ?? DEFAULT_SETTINGS.runtime.lockPollMs;
  }

  updateWaitSettings(options: LockWaitOptions): void {
    this.waitMs = options.waitMs ?? this.waitMs;
    this.pollMs = options.pollMs ?? this.pollMs;
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore() === this) {
      return Promise.reject(new Error('Lifecycle lock cannot be acquired recursively.'));
    }
    const result = this.queue.then(() => this.execute(operation));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    const identity = await LifecycleLock.inspectSelf();
    const owner: LockOwner = { version: 1, ...identity, workspaceRoot: this.paths.root, token: randomUUID() };
    const started = Date.now();
    while (!await this.store.acquire(owner)) {
      try {
        if (await this.store.reclaimExpired(inspectProcess)) continue;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          if (await this.store.isMissing()) continue;
          // A newly claimed directory may be publishing owner.json. Wait, never steal it.
          if (Date.now() - started < this.waitMs) {
            await sleep(this.pollMs);
            continue;
          }
        }
        throw new Error('Lifecycle lock cannot be safely reclaimed.', { cause: error });
      }
      if (Date.now() - started >= this.waitMs) throw new Error('Another BRC lifecycle operation is in progress.');
      await sleep(this.pollMs);
    }
    try {
      return await this.context.run(this, operation);
    } finally {
      await this.store.releaseIfOwned(owner.token);
    }
  }


}
