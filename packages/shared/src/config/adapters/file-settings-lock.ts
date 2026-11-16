import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

/** Cross-process lock shared by every writer of config/brc.yaml. */
export class FileSettingsLock {
  constructor(private readonly configDirectory: string) {
    if (!path.isAbsolute(configDirectory)) throw new Error('Config lock directory must be absolute.');
  }

  async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(this.configDirectory, { recursive: true });
    signal?.throwIfAborted();
    const release = await lockfile.lock(this.configDirectory, {
      realpath: true,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  }
}
