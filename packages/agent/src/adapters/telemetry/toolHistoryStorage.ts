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

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D;
}

function writeFully(descriptor: number, buffer: Buffer, position: number): void {
  let written = 0;
  while (written < buffer.length) {
    written += fs.writeSync(descriptor, buffer, written, buffer.length - written, position + written);
  }
}

function readFully(descriptor: number, buffer: Buffer, length: number, position: number): void {
  let read = 0;
  while (read < length) {
    const count = fs.readSync(descriptor, buffer, read, length - read, position + read);
    if (count === 0) throw new Error('Unexpected end of tool history during verification.');
    read += count;
  }
}

export class ToolHistoryStorage {
  readonly file: string;
  private readonly target: string;

  constructor(directory: string) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'tool-history.json');
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
      const persisted: unknown = JSON.parse(fs.readFileSync(this.target, 'utf-8'));
      if (!Array.isArray(persisted)) throw new Error('Tool history must contain a JSON array.');
      return persisted.length === 0 ? '' : persisted.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      process.stderr.write(`Ignoring unreadable tool history: ${(error as Error).message}\n`);
      return null;
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

  appendLinesIncrementally(text: string): void {
    const entries = text.split('\n').filter((line) => line.length > 0);
    if (entries.length === 0) return;

    let descriptor: number;
    try {
      descriptor = fs.openSync(this.target, 'r+');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.rewriteText(entries.join('\n'));
        return;
      }
      throw error;
    }

    try {
      const size = fs.fstatSync(descriptor).size;
      const scanLength = Math.min(size, 64);
      let closePosition = -1;
      let isEmpty = false;
      if (scanLength > 0) {
        const buffer = Buffer.alloc(scanLength);
        fs.readSync(descriptor, buffer, 0, scanLength, size - scanLength);
        const bracket = buffer.lastIndexOf(0x5D);
        if (bracket >= 0) {
          closePosition = size - scanLength + bracket;
          let cursor = bracket - 1;
          while (cursor >= 0 && isJsonWhitespace(buffer[cursor])) cursor -= 1;
          isEmpty = cursor >= 0 && buffer[cursor] === 0x5B;
        }
      }

      if (closePosition < 0) {
        fs.closeSync(descriptor);
        descriptor = -1;
        this.rewriteText((this.readText() ?? '') + entries.join('\n') + '\n');
        return;
      }

      const tailLength = size - closePosition;
      const originalTail = Buffer.alloc(tailLength);
      fs.readSync(descriptor, originalTail, 0, tailLength, closePosition);

      fs.ftruncateSync(descriptor, closePosition);
      const payload = Buffer.from(`${isEmpty ? '' : ','}${entries.join(',')}]`, 'utf8');
      writeFully(descriptor, payload, closePosition);

      try {
        const finalSize = closePosition + payload.length;
        const committed = Buffer.alloc(finalSize);
        readFully(descriptor, committed, finalSize, 0);
        JSON.parse(committed.toString('utf8'));
      } catch {
        fs.ftruncateSync(descriptor, closePosition);
        writeFully(descriptor, originalTail, closePosition);
      }
    } finally {
      if (descriptor >= 0) fs.closeSync(descriptor);
    }
  }

  rewriteText(text: string): void {
    const records = text.split('\n').filter((line) => line.length > 0).map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return line; }
    });
    const encoded = JSON.stringify(records);
    const temporary = `${this.target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      try {
        fs.copyFileSync(this.target, temporary, fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(temporary, encoded, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fs.writeFileSync(temporary, encoded, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      }
      fs.renameSync(temporary, this.target);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* The rename removes the temporary file. */ }
    }
  }
}
