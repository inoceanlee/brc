import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from '../config/paths.js';
import type { BrcSettings } from '../config/settings.js';
import type { LockedServiceOperations, ServiceManager } from '../core/lifecycle/workflow.js';
import { processArchive, readChecksum, renderConfig, type TraefikRelease, type VersionManifest } from './core.js';
import { readManifest, TraefikInput, type TraefikInputOptions } from './input.js';
import { ensureSafeDirectory, TraefikOutput } from './output.js';
import { runHealthProbe, verifyExecutable, waitForConfigGeneration } from './runtime.js';

export interface TraefikProgressEvent {
  operation: 'setup' | 'update' | 'rollback' | 'config';
  stage: 'release' | 'download' | 'verify' | 'stage' | 'health' | 'activate' | 'config';
  status: 'started' | 'completed' | 'failed';
  completedBytes?: number;
  totalBytes?: number;
}
export type TraefikProgressReporter = (event: TraefikProgressEvent) => void;

export interface TraefikManagerOptions extends TraefikInputOptions {
  verifyExecutable?: (filename: string, version: string) => Promise<void>;
  healthCheck?: (filename: string, version: string) => Promise<void>;
  loadSettings?: () => Promise<Readonly<BrcSettings>>;
  reporter?: TraefikProgressReporter;
}

export type TraefikLifecycle = Pick<ServiceManager, 'status' | 'withLock'>;

export class TraefikManager {
  private queue: Promise<void> = Promise.resolve();
  private readonly input: TraefikInput;
  private readonly output: TraefikOutput;
  private readonly verify: (filename: string, version: string) => Promise<void>;
  private readonly healthCheck: (filename: string, version: string) => Promise<void>;
  private readonly loadSettings: () => Promise<Readonly<BrcSettings>>;
  private readonly reporter?: TraefikProgressReporter;

  constructor(
    private readonly paths: BrcPaths,
    settings: Readonly<BrcSettings>,
    private readonly lifecycle: TraefikLifecycle,
    options: TraefikManagerOptions = {},
  ) {
    this.input = new TraefikInput(options);
    this.output = new TraefikOutput(paths);
    this.reporter = options.reporter;
    this.loadSettings = options.loadSettings ?? (async () => settings);
    this.verify = options.verifyExecutable ?? ((filename, version) => verifyExecutable(filename, version, settings));
    this.healthCheck = options.healthCheck ?? (async (filename) => runHealthProbe(filename, paths, settings, await this.input.readTemplates()));
  }

  setup(): Promise<void> {
    return this.exclusive(async () => {
      await this.prepareDirectories();
      const installed = await readManifest(this.paths.traefik);
      if (installed) {
        const executable = await this.output.executableFor(installed.current);
        await this.progress('setup', 'verify', () => this.verify(executable, installed.current));
        await this.progress('setup', 'health', () => this.healthCheck(executable, installed.current));
        await this.lifecycle.withLock(async () => {
          const current = await readManifest(this.paths.traefik);
          if (!current || current.current !== installed.current) {
            throw new Error('Traefik installation changed while setup was waiting for the lifecycle lock.');
          }
          const status = await this.serviceStatus();
          if (status?.state === 'starting' || status?.state === 'degraded') {
            throw new Error(`Cannot apply Traefik configuration while its service is ${status.state}: ${status.detail}`);
          }
          if (status?.state !== 'running') await this.writeCurrentConfig();
        });
        return;
      }

      const release = await this.progress('setup', 'release', () => this.input.latestRelease());
      const stage = await this.stageRelease(release, 'setup');
      try {
        await this.progress('setup', 'health', () => this.validateCandidate(stage, release));
        await this.lifecycle.withLock(async () => {
          if (await readManifest(this.paths.traefik)) return;
          await this.writeCurrentConfig();
          await this.progress('setup', 'activate', () => this.output.promoteVersion(stage, release.version, null));
        });
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
  }

  update(): Promise<void> {
    return this.exclusive(async () => {
      await this.prepareDirectories();
      const initiallyInstalled = await readManifest(this.paths.traefik);
      if (!initiallyInstalled) throw new Error('Traefik is not installed. Run brc setup first.');
      const release = await this.progress('update', 'release', () => this.input.latestRelease());
      if (release.version === initiallyInstalled.current) {
        await this.lifecycle.withLock(async () => {
          const current = await readManifest(this.paths.traefik);
          if (!current) throw new Error('Traefik is not installed. Run brc setup first.');
          if (current.current !== release.version) {
            throw new Error('Traefik installation changed while update was waiting for the lifecycle lock; retry the update.');
          }
        });
        return;
      }

      const stage = await this.stageRelease(release, 'update');
      try {
        await this.progress('update', 'health', () => this.validateCandidate(stage, release));
        await this.lifecycle.withLock(async (operations) => {
          const installed = await readManifest(this.paths.traefik);
          if (!installed) throw new Error('Traefik is not installed. Run brc setup first.');
          if (release.version === installed.current) {
            return;
          }
          const running = await this.isRunning();
          try {
            if (running) await operations.stop();
            await this.progress('update', 'activate', () => this.output.promoteVersion(stage, release.version, installed.current));
            if (running) {
              await operations.start();
              if (!await this.isRunning()) throw new Error('Traefik did not become healthy after update.');
            }
          } catch (error) {
            await this.restoreVersion(installed, running, operations, error);
          }
        });
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
  }

  async currentVersion(): Promise<string | null> {
    return (await readManifest(this.paths.traefik))?.current ?? null;
  }

  rollbackUpdate(): Promise<void> {
    return this.exclusive(async () => {
      const initial = await readManifest(this.paths.traefik);
      if (!initial?.previous) throw new Error('No previous Traefik version is available for rollback.');
      const previousVersion = initial.previous;
      const executable = await this.output.executableFor(previousVersion);
      await this.progress('rollback', 'verify', () => this.verify(executable, previousVersion));
      await this.progress('rollback', 'health', () => this.healthCheck(executable, previousVersion));
      const rollback: VersionManifest = { version: 1, current: previousVersion, previous: initial.current };
      await this.lifecycle.withLock(async (operations) => {
        const installed = await readManifest(this.paths.traefik);
        if (!installed || installed.current !== initial.current || installed.previous !== initial.previous) {
          throw new Error('Traefik installation changed while rollback was waiting for the lifecycle lock.');
        }
        const wasRunning = await this.isRunning();
        try {
          if (wasRunning) await operations.stop();
          await this.progress('rollback', 'activate', () => this.output.writeManifest(rollback));
          if (wasRunning) {
            await operations.start();
            if (!await this.isRunning()) throw new Error('Traefik did not become healthy after rollback.');
          }
        } catch (error) {
          await this.restoreVersion(installed, wasRunning, operations, error);
        }
      });
    });
  }

  writeConfig(previous?: Readonly<BrcSettings>): Promise<void> {
    return this.lifecycle.withLock(async () => {
      await this.progress('config', 'config', async () => this.writeConfigAndConfirm(await this.loadSettings(), previous));
    });
  }
  writeConfigWithLockHeld(settings: Readonly<BrcSettings>, previous?: Readonly<BrcSettings>): Promise<void> {
    return this.progress('config', 'config', () => this.writeConfigAndConfirm(settings, previous));
  }

  private async writeCurrentConfig(): Promise<void> {
    await this.writeConfigAndConfirm(await this.loadSettings(), undefined);
  }

  private async writeConfigAndConfirm(
    settings: Readonly<BrcSettings>,
    previous: Readonly<BrcSettings> | undefined,
  ): Promise<void> {
    const status = await this.serviceStatus();
    if (status?.state === 'starting' || status?.state === 'degraded') {
      throw new Error(`Cannot apply Traefik configuration while its service is ${status.state}: ${status.detail}`);
    }
    if (status?.state === 'running' && !previous) {
      throw new Error('Previous settings are required to safely apply Traefik configuration while its service is running.');
    }
    const dynamicSettings = status?.state === 'running' && previous
      && previous.services.relayPort !== settings.services.relayPort
      ? { ...settings, services: { ...settings.services, relayPort: previous.services.relayPort } }
      : settings;
    const staticSettings = status?.state === 'running' && previous ? previous : settings;
    const generation = randomUUID();
    const templates = await this.input.readTemplates();
    const config = renderConfig({ templates, dynamicSettings, staticSettings, dynamicPath: path.join(this.paths.traefik, 'config', 'dynamic.yml'), generation });
    await this.output.writeConfig(config);
    if (status?.state !== 'running') return;
    const ports = previous
      ? [settings.services.healthPort, previous.services.healthPort]
      : [settings.services.healthPort];
    await waitForConfigGeneration(ports, generation, settings.runtime.startupTimeoutMs);
  }

  private async serviceStatus() {
    return (await this.lifecycle.status()).find((service) => service.name === 'traefik');
  }

  private async validateCandidate(stage: string, release: TraefikRelease): Promise<void> {
    const executableName = process.platform === 'win32' ? 'traefik.exe' : 'traefik';
    const executable = path.join(stage, executableName);
    await this.verify(executable, release.version);
    await this.healthCheck(executable, release.version);
  }

  private async stageRelease(release: TraefikRelease, operation: 'setup' | 'update'): Promise<string> {
    const checksum = await this.progress(operation, 'release', async () =>
      readChecksum(await this.input.downloadChecksum(release), release.archiveName));
    this.emit({ operation, stage: 'download', status: 'started' });
    let archive: Buffer;
    try {
      archive = await this.input.downloadArchive(release, (completedBytes, totalBytes) => {
        this.emit({ operation, stage: 'download', status: 'started', completedBytes, totalBytes });
      });
      this.emit({ operation, stage: 'download', status: 'completed' });
    } catch (error) {
      this.emit({ operation, stage: 'download', status: 'failed' });
      throw error;
    }
    const executableName = process.platform === 'win32' ? 'traefik.exe' : 'traefik';
    const executable = await this.progress(operation, 'verify', () => processArchive(archive, checksum, release.archiveName, executableName));
    return this.progress(operation, 'stage', () => this.output.stageArchive(release, executable));
  }

  private async progress<T>(operation: TraefikProgressEvent['operation'], stage: TraefikProgressEvent['stage'], action: () => Promise<T>): Promise<T> {
    this.emit({ operation, stage, status: 'started' });
    try {
      const result = await action();
      this.emit({ operation, stage, status: 'completed' });
      return result;
    } catch (error) {
      this.emit({ operation, stage, status: 'failed' });
      throw error;
    }
  }

  private emit(event: TraefikProgressEvent): void {
    try {
      this.reporter?.(event);
    } catch {
      // Progress output must not change the operation or its cleanup.
    }
  }

  private async isRunning(): Promise<boolean> {
    const status = await this.serviceStatus();
    if (!status) throw new Error('Traefik is not registered with the lifecycle service manager.');
    if (status.state === 'starting' || status.state === 'degraded') {
      throw new Error(`Cannot change Traefik version while its service is ${status.state}: ${status.detail}`);
    }
    return status.state === 'running';
  }

  private async restoreVersion(
    manifest: VersionManifest,
    wasRunning: boolean,
    operations: LockedServiceOperations,
    cause: unknown,
  ): Promise<never> {
    const errors: unknown[] = [cause];
    try {
      await this.output.writeManifest(manifest);
    } catch (error) {
      errors.push(error);
    }
    if (wasRunning) {
      try {
        await operations.start();
        if (!await this.isRunning()) throw new Error('Traefik did not become healthy after rollback recovery.');
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Traefik update failed and rollback was incomplete.');
    throw cause;
  }

  private async prepareDirectories(): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await ensureSafeDirectory(this.paths.root, path.join(this.paths.traefik, 'versions'));
    await ensureSafeDirectory(this.paths.root, this.paths.tmp);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
