import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from '../../config/paths.js';

export type LogComponent = 'relay' | 'agent' | 'traefik' | 'cli';

const LOG_COMPONENTS: readonly LogComponent[] = ['relay', 'agent', 'traefik'];
const MAX_OUTPUT_BYTES = 64 * 1024;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function verifyLogDirectory(paths: BrcPaths): Promise<boolean> {
  const root = path.resolve(paths.root);
  const logs = path.resolve(paths.logs);
  if (!isWithin(root, logs)) throw new Error('Log directory is outside the BRC data root.');

  let current = root;
  for (const segment of ['', ...path.relative(root, logs).split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Log directory path contains a link or non-directory entry.');
    }
  }
  return true;
}

async function readTail(filename: string): Promise<Buffer | null> {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Log path is not a regular file.');

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const file = await open(filename, flags);
  try {
    const openedInfo = await file.stat();
    const currentInfo = await lstat(filename);
    if (
      !openedInfo.isFile()
      || currentInfo.isSymbolicLink()
      || !currentInfo.isFile()
      || openedInfo.dev !== currentInfo.dev
      || openedInfo.ino !== currentInfo.ino
    ) {
      throw new Error('Log path changed or is not a regular file.');
    }

    const length = Math.min(openedInfo.size, MAX_OUTPUT_BYTES);
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, openedInfo.size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function readComponent(paths: BrcPaths, component: LogComponent): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  for (const filename of [`${component}.log.1`, `${component}.log`]) {
    const chunk = await readTail(path.join(paths.logs, filename));
    if (chunk) chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const contents = Buffer.concat(chunks);
  return contents.length > MAX_OUTPUT_BYTES ? contents.subarray(contents.length - MAX_OUTPUT_BYTES) : contents;
}

export async function readManagedLog(paths: BrcPaths, component: LogComponent): Promise<string | null> {
  if (!await verifyLogDirectory(paths)) return null;
  const contents = await readComponent(paths, component);
  return contents?.toString('utf8') ?? null;
}

export async function showLogs(
  paths: BrcPaths,
  component: LogComponent | undefined,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  let logDirectoryExists: boolean;
  try {
    logDirectoryExists = await verifyLogDirectory(paths);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!logDirectoryExists) {
    writeError(component ? `${component} log not found.` : 'No service logs were found.');
    return 0;
  }

  const components = component ? [component] : LOG_COMPONENTS;
  let found = false;
  let failed = false;
  for (const name of components) {
    try {
      const contents = await readComponent(paths, name);
      if (!contents) continue;
      found = true;
      write(`${name} log:\n${contents.toString('utf8')}`);
    } catch (error) {
      failed = true;
      writeError(`${name} log could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!found && !failed) {
    writeError(component ? `${component} log not found.` : 'No service logs were found.');
    return 0;
  }
  return failed ? 1 : 0;
}
