import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ArchiveBinaryEntry } from './archive.js';
import type { BrcPaths } from '../../config/paths.js';
import { errorCode, type TraefikRelease, type TraefikTemplates, type VersionManifest } from '../../core/traefik/rules.js';


export class TraefikOutput {
  constructor(private readonly paths: BrcPaths) { }

  async writeConfig(config: TraefikTemplates): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    const configDirectory = path.join(this.paths.traefik, 'config');
    await ensureSafeDirectory(this.paths.root, configDirectory);
    await writeAtomic(path.join(configDirectory, 'dynamic.yml'), config.dynamicConfig);
    await writeAtomic(path.join(configDirectory, 'traefik.yml'), config.staticConfig);
  }

  async stageArchive(release: Pick<TraefikRelease, 'version'>, executable: ArchiveBinaryEntry): Promise<string> {
    const versionsDirectory = path.join(this.paths.traefik, 'versions');
    const stage = path.join(versionsDirectory, `.staging-${release.version}-${randomUUID()}`);
    const binaryName = executable.name || (process.platform === 'win32' ? 'traefik.exe' : 'traefik');
    const target = path.join(stage, binaryName);
    await ensureSafeDirectory(this.paths.root, versionsDirectory);
    await mkdir(stage);
    try {
      await ensureSafeDirectory(this.paths.root, stage);
      await pipeline(resolveEntryStream(executable), createWriteStream(target, { flags: 'wx' }));
      await ensureRegularFile(target);
      if ((await stat(target)).size !== resolveEntrySize(executable)) {
        throw new Error('Extracted Traefik executable size does not match its archive entry.');
      }
      if (process.platform !== 'win32') {
        await chmod(target, 0o755);
      }
      return stage;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  async writeManifest(manifest: VersionManifest): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await writeAtomic(path.join(this.paths.traefik, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async promoteVersion(stage: string, version: string, previous: string | null): Promise<void> {
    const versionsDirectory = path.join(this.paths.traefik, 'versions');
    const targetDirectory = path.join(versionsDirectory, version);
    let promoted = false;
    try {
      await lstat(targetDirectory);
      await ensureSafeDirectory(this.paths.root, targetDirectory);
      const binaryName = (await lstat(path.join(stage, 'traefik.exe')).catch(() => null))
        ? 'traefik.exe'
        : (process.platform === 'win32' ? 'traefik.exe' : 'traefik');
      const existingExecutable = path.join(targetDirectory, binaryName);
      await ensureRegularFile(existingExecutable);
      const stagedExecutable = path.join(stage, binaryName);
      if (await sha256File(existingExecutable) !== await sha256File(stagedExecutable)) {
        throw new Error(`Traefik version directory already contains different files: ${version}`);
      }
      await rm(stage, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await rename(stage, targetDirectory);
      promoted = true;
    }

    try {
      await this.writeManifest({ version: 1, current: version, previous: previous === version ? null : previous });
    } catch (error) {
      if (promoted) await rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async executableFor(version: string): Promise<string> {
    const versionDirectory = path.join(this.paths.traefik, 'versions', version);
    await ensureSafeDirectory(this.paths.root, versionDirectory);
    let executable = path.join(versionDirectory, process.platform === 'win32' ? 'traefik.exe' : 'traefik');
    try {
      await ensureRegularFile(executable);
      return executable;
    } catch {
      const fallback = path.join(versionDirectory, process.platform === 'win32' ? 'traefik' : 'traefik.exe');
      await ensureRegularFile(fallback);
      return fallback;
    }
  }

}
export async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Traefik path is outside its installation directory: ${directory}`);
  }

  await mkdir(resolvedRoot, { recursive: true });
  let current = resolvedRoot;
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Traefik installation path is not a regular directory: ${current}`);
  if (relative === '') return;

  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await lstat(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await mkdir(current);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Traefik path is not a regular directory: ${current}`);
  }
}

export async function ensureRegularFile(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Traefik path is not a regular file: ${filename}`);
}

export async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function writeAtomic(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
interface LegacyStreamEntry {
  stream(): NodeJS.ReadableStream;
}

function isLegacyStreamEntry(entry: unknown): entry is LegacyStreamEntry {
  return typeof entry === 'object' && entry !== null && 'stream' in entry && typeof (entry as Record<string, unknown>).stream === 'function';
}

interface LegacySizeEntry {
  uncompressedSize: number;
}

function isLegacySizeEntry(entry: unknown): entry is LegacySizeEntry {
  return typeof entry === 'object' && entry !== null && 'uncompressedSize' in entry && typeof (entry as Record<string, unknown>).uncompressedSize === 'number';
}

function resolveEntryStream(entry: ArchiveBinaryEntry): NodeJS.ReadableStream {
  if (typeof entry.openStream === 'function') {
    return entry.openStream();
  }
  if (isLegacyStreamEntry(entry)) {
    return entry.stream();
  }
  throw new Error('Archive entry does not provide a readable stream.');
}

function resolveEntrySize(entry: ArchiveBinaryEntry): number {
  if (typeof entry.size === 'number') {
    return entry.size;
  }
  if (isLegacySizeEntry(entry)) {
    return entry.uncompressedSize;
  }
  throw new Error('Archive entry size is missing.');
}

