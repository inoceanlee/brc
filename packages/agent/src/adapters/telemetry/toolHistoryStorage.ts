import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import lockfile from 'proper-lockfile';

function resolveHistoryFile(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const target = fs.readlinkSync(file);
      return resolveHistoryFile(path.resolve(path.dirname(file), target));
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (linkError as NodeJS.ErrnoException).code !== 'EINVAL') throw linkError;
      return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    }
  }
}

export class ToolHistoryStorage {
  readonly file: string;
  private readonly target: string;

  constructor(directory: string) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'tool-history.jsonl');
    this.target = resolveHistoryFile(this.file);
  }

  withLock<T>(operation: () => T): T {
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        release = lockfile.lockSync(this.target, { realpath: false, stale: 120_000 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || attempt === 99) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.removeAbandonedTemporaryFiles();
      return operation();
    } finally {
      // A release error must not cause a committed write to be queued again.
      try { release!(); } catch { /* The lock expires if removal fails. */ }
    }
  }

  private removeAbandonedTemporaryFiles(): void {
    const directory = path.dirname(this.target);
    const prefix = `${path.basename(this.target)}.`;
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      const match = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i.exec(suffix);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      const temporary = path.join(directory, name);
      try {
        if (fs.lstatSync(temporary).isFile()) fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  readText(): string | null {
    try {
      return fs.readFileSync(this.target, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  size(): number {
    try {
      return fs.statSync(this.target).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  appendText(text: string): void {
    this.rewriteText((this.readText() ?? '') + text);
  }

  rewriteText(text: string): void {
    const temporary = `${this.target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      try {
        fs.copyFileSync(this.target, temporary, fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(temporary, text, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fs.writeFileSync(temporary, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      }
      fs.renameSync(temporary, this.target);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* The rename removes the temporary file. */ }
    }
  }
}
