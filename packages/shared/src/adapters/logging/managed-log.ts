import type { Stats } from 'node:fs';
import { appendFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_LOG_ROTATE_BYTES } from '../../config/core/settings.js';
export { DEFAULT_LOG_ROTATE_BYTES as DEFAULT_MANAGED_LOG_MAX_BYTES } from '../../config/core/settings.js';

const ROTATION_SUFFIX = '.1';
const TRUNCATION_MARKER = Buffer.from('\n[log entry truncated]\n');
const writeQueues = new Map<string, Promise<void>>();

type FileInfo = Stats;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function fileInfo(filename: string): Promise<FileInfo | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to write managed log through a non-file path: ${filename}`);
    return info;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function keepTail(filename: string, info: FileInfo, maxBytes: number): Promise<number> {
  if (info.size <= maxBytes) return info.size;
  const handle = await open(filename, 'r+');
  try {
    const tail = Buffer.alloc(maxBytes);
    await handle.read(tail, 0, maxBytes, info.size - maxBytes);
    await handle.truncate(0);
    await handle.write(tail, 0, tail.length, 0);
    return tail.length;
  } finally {
    await handle.close();
  }
}

function boundedChunk(input: string | Uint8Array, maxBytes: number): Buffer {
  const chunk = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (chunk.length <= maxBytes) return chunk;
  if (TRUNCATION_MARKER.length >= maxBytes) return chunk.subarray(chunk.length - maxBytes);
  return Buffer.concat([TRUNCATION_MARKER, chunk.subarray(chunk.length - (maxBytes - TRUNCATION_MARKER.length))]);
}

async function appendOnce(filename: string, chunk: Buffer, maxBytes: number): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const current = await fileInfo(filename);
  let size = current ? await keepTail(filename, current, maxBytes) : 0;
  if (size > 0 && size + chunk.length > maxBytes) {
    const backup = `${filename}${ROTATION_SUFFIX}`;
    if (await fileInfo(backup)) await unlink(backup);
    await rename(filename, backup);
    size = 0;
  }
  await appendFile(filename, chunk, { mode: 0o600 });
}

export async function appendRotatingLog(
  filename: string,
  input: string | Uint8Array,
  maxBytes = DEFAULT_LOG_ROTATE_BYTES,
): Promise<void> {
  if (!path.isAbsolute(filename)) throw new Error('Managed log path must be absolute.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Managed log size limit must be a positive safe integer.');
  const target = path.resolve(filename);
  const chunk = boundedChunk(input, maxBytes);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => appendOnce(target, chunk, maxBytes));
  writeQueues.set(target, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(target) === next) writeQueues.delete(target);
  }
}


export interface ManagedLogSink {
  write(input: string | Uint8Array): void;
  close(): Promise<void>;
}

export function createManagedLog(filename: string, maxBytes: number): ManagedLogSink {
  let pending = Promise.resolve();
  return {
    write(input) {
      pending = pending.then(() => appendRotatingLog(filename, input, maxBytes)).catch(() => undefined);
    },
    close: () => pending,
  };
}
