import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerConfig } from './config-manager.js';

export class ConfigStorage {
  constructor(private readonly configPath: string) {}

  async prepare(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
  }

  async read(): Promise<ServerConfig> {
    for (let attempt = 0; ; attempt++) {
      try {
        const value: unknown = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Agent configuration must be a JSON object');
        }
        return value as ServerConfig;
      } catch (error) {
        if (!(error instanceof SyntaxError) || attempt === 4) throw error;
        await delay(10);
      }
    }
  }

  async write(config: ServerConfig): Promise<void> {
    const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(config, null, 2), 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tempPath, this.configPath);
          break;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(String(code)) || attempt >= 3) {
            throw error;
          }
          await delay(20 * (attempt + 1));
        }
      }
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  lock(): Promise<() => Promise<void>> {
    return lockfile.lock(this.configPath, {
      realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 }
    });
  }

  watch(onChange: () => void): FSWatcher {
    const filename = path.basename(this.configPath);
    return watch(path.dirname(this.configPath), { persistent: false }, (_event, changed) => {
      if (!changed || changed.toString() === filename) onChange();
    });
  }
}
