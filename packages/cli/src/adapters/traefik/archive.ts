import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import unzipper, { type ZipEntry } from 'unzipper';
import { MAX_EXECUTABLE_BYTES, safeArchivePath, verifyChecksum } from '../../core/traefik/rules.js';

export interface ArchiveBinaryEntry {
  readonly name: string;
  readonly size: number;
  openStream(): NodeJS.ReadableStream;
  readonly path?: string;
  readonly uncompressedSize?: number;
  stream?(): NodeJS.ReadableStream;
}

export abstract class ArchiveExtractor {
  abstract extractExecutable(buffer: Buffer, expectedName: string): Promise<ArchiveBinaryEntry>;
}

export class ZipArchiveExtractor extends ArchiveExtractor {
  async extractExecutable(buffer: Buffer, expectedName: string): Promise<ArchiveBinaryEntry> {
    if (buffer.length === 0) {
      throw new Error('Traefik archive buffer is empty.');
    }
    if (typeof unzipper.Open?.buffer !== 'function') {
      throw new Error('ZIP library does not support in-memory archive processing.');
    }

    const directory = await unzipper.Open.buffer(buffer);
    const names = new Set<string>();
    let executableEntry: ZipEntry | undefined;

    for (const entry of directory.files) {
      if (!safeArchivePath(entry.path)) {
        throw new Error(`Traefik archive contains an unsafe path: ${entry.path}`);
      }
      if (names.has(entry.path)) {
        throw new Error(`Traefik archive contains a duplicate path: ${entry.path}`);
      }
      names.add(entry.path);

      if (entry.uncompressedSize > MAX_EXECUTABLE_BYTES) {
        throw new Error(`Traefik archive contains an entry exceeding size limit: ${entry.path}`);
      }

      if (entry.path === expectedName && entry.type === 'File') {
        executableEntry = entry;
      }
    }

    const size = executableEntry?.uncompressedSize;
    if (!executableEntry || typeof size !== 'number' || size < 1 || size > MAX_EXECUTABLE_BYTES) {
      throw new Error(`Traefik archive does not contain a valid root-level ${expectedName}.`);
    }

    return {
      name: executableEntry.path,
      size: executableEntry.uncompressedSize,
      openStream: () => executableEntry.stream(),
    };
  }
}

function parseTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  const content = nullIdx === -1 ? slice : slice.subarray(0, nullIdx);
  return content.toString('utf8').trim();
}

function parseTarOctal(buf: Buffer, offset: number, length: number): number {
  if (buf[offset] & 0x80) {
    let size = 0;
    for (let i = 1; i < length; i++) {
      size = size * 256 + buf[offset + i];
    }
    return size;
  }
  const str = parseTarString(buf, offset, length);
  if (!str) return 0;
  const val = parseInt(str, 8);
  return Number.isNaN(val) ? 0 : val;
}

export class TarGzArchiveExtractor extends ArchiveExtractor {
  async extractExecutable(buffer: Buffer, expectedName: string): Promise<ArchiveBinaryEntry> {
    if (buffer.length === 0) {
      throw new Error('Traefik archive buffer is empty.');
    }

    const gunzip = zlib.createGunzip();
    const names = new Set<string>();
    let executable: { name: string; size: number; chunks: Buffer[] } | undefined;
    let bufferQueue = Buffer.alloc(0);

    let state: 'header' | 'data' = 'header';
    let currentEntry: { name: string; size: number; isMatch: boolean } | null = null;
    let remainingDataBytes = 0;
    let remainingPaddingBytes = 0;
    let capturedChunks: Buffer[] = [];
    let overrideName: string | null = null;
    let isOverrideNameEntry = false;
    let overrideNameChunks: Buffer[] = [];

    const stream = Readable.from(buffer).pipe(gunzip);

    for await (const chunk of stream) {
      bufferQueue = Buffer.concat([bufferQueue, chunk as Buffer]);

      let keepProcessing = true;
      while (keepProcessing) {
        if (state === 'header') {
          if (bufferQueue.length < 512) {
            keepProcessing = false;
            break;
          }
          const header = bufferQueue.subarray(0, 512);
          bufferQueue = bufferQueue.subarray(512);

          const isZero = header.every((b) => b === 0);
          if (isZero) {
            continue;
          }

          const rawName = parseTarString(header, 0, 100);
          const typeflag = String.fromCharCode(header[156]);
          const magic = parseTarString(header, 257, 6);
          const prefix = magic.startsWith('ustar') ? parseTarString(header, 345, 155) : '';
          const resolvedName = overrideName ?? (prefix ? `${prefix}/${rawName}` : rawName);
          overrideName = null;

          if (typeflag === 'L') {
            const size = parseTarOctal(header, 124, 12);
            if (size < 0 || size > 65536) {
              throw new Error('Traefik archive contains an invalid long filename header.');
            }
            isOverrideNameEntry = true;
            overrideNameChunks = [];
            remainingDataBytes = size;
            const remainder = size % 512;
            remainingPaddingBytes = remainder === 0 ? 0 : 512 - remainder;
            state = 'data';
            continue;
          }

          isOverrideNameEntry = false;
          const entryPath = resolvedName.startsWith('./') ? resolvedName.slice(2) : resolvedName;

          if (!safeArchivePath(entryPath)) {
            throw new Error(`Traefik archive contains an unsafe path: ${entryPath}`);
          }
          if (names.has(entryPath)) {
            throw new Error(`Traefik archive contains a duplicate path: ${entryPath}`);
          }
          names.add(entryPath);

          const size = parseTarOctal(header, 124, 12);
          if (size < 0 || size > MAX_EXECUTABLE_BYTES) {
            throw new Error(`Traefik archive contains an entry exceeding size limit: ${entryPath}`);
          }

          const isMatch = entryPath === expectedName && (typeflag === '0' || typeflag === '\0' || typeflag === '');

          if (size === 0) {
            if (isMatch) {
              throw new Error(`Traefik archive does not contain a valid root-level ${expectedName}.`);
            }
            continue;
          }

          currentEntry = { name: entryPath, size, isMatch };
          remainingDataBytes = size;
          const remainder = size % 512;
          remainingPaddingBytes = remainder === 0 ? 0 : 512 - remainder;
          if (isMatch) {
            capturedChunks = [];
          }
          state = 'data';
        }

        if (state === 'data') {
          if (remainingDataBytes > 0) {
            if (bufferQueue.length === 0) {
              keepProcessing = false;
              break;
            }
            const take = Math.min(bufferQueue.length, remainingDataBytes);
            const dataSlice = bufferQueue.subarray(0, take);
            bufferQueue = bufferQueue.subarray(take);
            remainingDataBytes -= take;
            if (isOverrideNameEntry) {
              overrideNameChunks.push(Buffer.from(dataSlice));
            } else if (currentEntry?.isMatch) {
              capturedChunks.push(Buffer.from(dataSlice));
            }
          }

          if (remainingDataBytes === 0 && remainingPaddingBytes > 0) {
            if (bufferQueue.length === 0) {
              keepProcessing = false;
              break;
            }
            const takePad = Math.min(bufferQueue.length, remainingPaddingBytes);
            bufferQueue = bufferQueue.subarray(takePad);
            remainingPaddingBytes -= takePad;
          }

          if (remainingDataBytes === 0 && remainingPaddingBytes === 0) {
            if (isOverrideNameEntry) {
              overrideName = Buffer.concat(overrideNameChunks).toString('utf8').replace(/\0.*$/, '').trim();
            } else if (currentEntry?.isMatch) {
              executable = {
                name: currentEntry.name,
                size: currentEntry.size,
                chunks: capturedChunks,
              };
            }
            state = 'header';
            currentEntry = null;
            isOverrideNameEntry = false;
          }
        }
      }
    }

    if (state === 'data' && remainingDataBytes > 0) {
      throw new Error('Unexpected end of tar stream while reading entry data.');
    }

    if (!executable || executable.size < 1 || executable.size > MAX_EXECUTABLE_BYTES) {
      throw new Error(`Traefik archive does not contain a valid root-level ${expectedName}.`);
    }

    return {
      name: executable.name,
      size: executable.size,
      openStream: () => Readable.from(executable.chunks),
    };
  }
}

export class ArchiveExtractorFactory {
  static create(archiveExt: 'zip' | 'tar.gz'): ArchiveExtractor {
    const normalized = archiveExt.startsWith('.') ? archiveExt.slice(1) : archiveExt;
    if (normalized === 'zip') {
      return new ZipArchiveExtractor();
    }
    if (normalized === 'tar.gz' || normalized === 'tgz') {
      return new TarGzArchiveExtractor();
    }
    throw new Error(`Unsupported archive format: ${archiveExt as string}`);
  }
}

export async function processArchive(
  archive: Buffer,
  expectedChecksum: string,
  archiveNameOrFormat: string = 'windows_amd64.zip',
  expectedExecutableName: string = process.platform === 'win32' ? 'traefik.exe' : 'traefik',
): Promise<ArchiveBinaryEntry> {
  const actualChecksum = createHash('sha256').update(archive).digest('hex');
  verifyChecksum(actualChecksum, expectedChecksum);

  const format: 'zip' | 'tar.gz' = archiveNameOrFormat.endsWith('.tar.gz') ? 'tar.gz' : 'zip';
  const extractor = ArchiveExtractorFactory.create(format);
  const entry = await extractor.extractExecutable(archive, expectedExecutableName);
  return {
    name: entry.name,
    size: entry.size,
    openStream: () => entry.openStream(),
    path: entry.name,
    uncompressedSize: entry.size,
    stream: () => entry.openStream(),
  };
}
