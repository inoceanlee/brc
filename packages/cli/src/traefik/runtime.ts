import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendRotatingLog, startManagedControlServer, type InjectedDiagnosticsRuntime, type ManagedControlServer, type ManagedLogSink } from 'brc-shared';
import { DEFAULT_SETTINGS, type BrcSettings } from '../config/settings.js';
import type { BrcPaths } from '../config/paths.js';
import { renderConfig, errorMessage, type TraefikTemplates } from './core.js';
import { readManifest } from './input.js';
import { ensureRegularFile, ensureSafeDirectory } from './output.js';
const execFile = promisify(execFileCallback);

type ChildProcess = ReturnType<typeof spawn>;

export interface TraefikBinaryResourceMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TraefikRuntimeOptions {
  managedLog?: ManagedLogSink;
  managedLogError?: () => Error | undefined;
  controlServer?: Server;
  controlIdentity?: { token?: string; readyFile?: string; id?: string; service?: string };
  createBinaryResourceMonitor?: (pid: number, instanceId: string) => Promise<TraefikBinaryResourceMonitor>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local test server did not receive a TCP port.'));
      resolve(address.port);
    });
  });
}

async function reservePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    const ports = await Promise.all(servers.map((server) => listen(server)));
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    return ports;
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    throw error;
  }
}

function requestStatus(port: number, pathname: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestHandle = request({ host: '127.0.0.1', port, method: 'GET', path: pathname, agent: false, signal }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    requestHandle.setTimeout(1_000, () => requestHandle.destroy());
    requestHandle.once('error', (error) => signal?.aborted ? reject(signal.reason ?? error) : resolve(0));
    requestHandle.end();
  });
}
function requestConfigGeneration(port: number, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const requestHandle = request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/ping',
      agent: false,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const generation = response.headers['x-brc-config-generation'];
      response.resume();
      response.once('end', () => {
        const value = Array.isArray(generation) ? generation[0] : generation;
        resolve(response.statusCode === 200 ? value : undefined);
      });
    });
    requestHandle.once('error', reject);
    requestHandle.end();
  });
}

export async function waitForConfigGeneration(
  ports: readonly number[],
  generation: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = [...new Set(ports)];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    for (const port of candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        if (await requestConfigGeneration(port, Math.min(1_000, remaining), signal) === generation) return;
      } catch {
        signal?.throwIfAborted();
        // Retry until Traefik reports the active generation or the deadline expires.
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(50, remaining), undefined, { signal });
  }
  throw new Error('Traefik did not apply dynamic configuration before the timeout.');
}


async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function verifyExecutable(
  filename: string,
  expectedVersion: string,
  settings: Readonly<BrcSettings> = DEFAULT_SETTINGS,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0) throw new Error('Traefik executable is empty or missing.');
  const { stdout, stderr } = await execFile(filename, ['version'], {
    windowsHide: true,
    timeout: settings.runtime.startupTimeoutMs,
    maxBuffer: 1024 * 1024,
    signal,
  });
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/\bVersion:\s*v?(\d+\.\d+\.\d+)\b/);
  if (match?.[1] !== expectedVersion) throw new Error(`Traefik executable version does not match ${expectedVersion}: ${output.trim()}`);
}

async function waitForHealth(child: ChildProcess, port: number, timeoutMs: number, detail: () => string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Traefik exited before becoming healthy: ${detail()}`);
    if (await requestStatus(port, '/ping', signal) === 200) return;
    await sleep(100, undefined, { signal });
  }
  throw new Error(`Traefik did not become healthy on /ping: ${detail()}`);
}

export async function runHealthProbe(
  filename: string,
  paths: BrcPaths,
  settings: Readonly<BrcSettings>,
  templates: TraefikTemplates,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await ensureSafeDirectory(paths.root, paths.tmp);
  const directory = path.join(paths.tmp, `traefik-probe-${randomUUID()}`);
  await mkdir(directory);
  const backend = createServer((_request, response) => response.writeHead(200).end('ok'));
  let child: ChildProcess | undefined;
  let childError: Error | undefined;
  let logs = '';
  try {
    const backendPort = await listen(backend);
    const [proxyPort, healthPort] = await reservePorts(2);
    const dynamicPath = path.join(directory, 'dynamic.yml');
    const staticPath = path.join(directory, 'traefik.yml');
    const probeSettings: BrcSettings = {
      ...settings,
      services: { ...settings.services, relayPort: backendPort, proxyPort, healthPort },
    };
    const config = renderConfig({ templates, dynamicSettings: probeSettings, staticSettings: probeSettings, dynamicPath, generation: randomUUID() });
    await writeFile(dynamicPath, config.dynamicConfig, { flag: 'wx' });
    await writeFile(staticPath, config.staticConfig, { flag: 'wx' });

    child = spawn(filename, [`--configFile=${staticPath}`], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    child.stdout?.on('data', (chunk: Buffer) => { logs = `${logs}${chunk.toString('utf8')}`.slice(-8192); });
    child.stderr?.on('data', (chunk: Buffer) => { logs = `${logs}${chunk.toString('utf8')}`.slice(-8192); });
    child.once('error', (error) => { childError = error; });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve());
      child?.once('error', reject);
    });
    await waitForHealth(child, healthPort, settings.runtime.startupTimeoutMs, () => childError?.message ?? logs, signal);

    const deadline = Date.now() + settings.runtime.startupTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await requestStatus(proxyPort, '/__brc_probe', signal) === 200) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(100, undefined, { signal });
    }
    throw new Error(`Traefik dynamic route failed its local health probe: ${childError?.message ?? logs}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, settings.runtime.shutdownTimeoutMs);
    }
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function environmentPort(name: string): number {
  const value = process.env[name];
  const port = Number(value);
  if (!value || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535.`);
  return port;
}

export async function runManagedTraefikService(
  settings: Readonly<BrcSettings> = DEFAULT_SETTINGS,
  diagnostics?: Pick<InjectedDiagnosticsRuntime, 'log'>,
  options: TraefikRuntimeOptions = {},
): Promise<void> {
  const managedLog = options.managedLog;
  let control: ManagedControlServer | undefined;
  let child: ChildProcess | undefined;
  let binaryMonitor: TraefikBinaryResourceMonitor | undefined;
  let logFailure: Error | undefined;
  let stopping = false;
  let logSink: Writable | undefined;
  try {
    const traefikRoot = process.env.BRC_TRAEFIK_ROOT;
    const configDirectory = process.env.BRC_TRAEFIK_CONFIG_DIR;
    const logFile = process.env.BRC_LOG_FILE;
    if (process.env.BRC_MANAGED_SERVICE !== 'traefik' || !traefikRoot || !configDirectory || !logFile) {
      throw new Error('Traefik service is missing its managed runtime configuration.');
    }
    const manifest = await readManifest(traefikRoot);
    if (!manifest) throw new Error('Traefik is not installed. Run brc setup first.');
    await ensureSafeDirectory(traefikRoot, path.join(traefikRoot, 'versions', manifest.current));
    await ensureSafeDirectory(traefikRoot, configDirectory);
    const executableName = process.platform === 'win32' ? 'traefik.exe' : 'traefik';
    const executable = path.join(traefikRoot, 'versions', manifest.current, executableName);
    const configFile = path.join(configDirectory, 'traefik.yml');
    await ensureRegularFile(executable);
    await ensureRegularFile(configFile);
    await ensureRegularFile(path.join(configDirectory, 'dynamic.yml'));
    await verifyExecutable(executable, manifest.current, settings);
    const healthPort = environmentPort('BRC_TRAEFIK_HEALTH_PORT');

    await mkdir(path.dirname(logFile), { recursive: true });
    logSink = new Writable({
      write(chunk, _encoding, callback) {
        void appendRotatingLog(logFile, chunk, settings.logs.rotateMiB * 1024 * 1024).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
    logSink.on('error', (error: Error) => { logFailure = error; });
    child = spawn(executable, [`--configFile=${configFile}`], { cwd: traefikRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const childClosed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child?.once('close', (code, signal) => resolve([code, signal]));
    });
    child.stdout?.pipe(logSink, { end: false });
    child.stderr?.pipe(logSink, { end: false });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve());
      child?.once('error', reject);
    });
    if (!child.pid) throw new Error('Traefik binary process did not receive a PID.');
    const binaryInstanceId = `${process.env.BRC_MANAGED_ID ?? process.pid}-binary`;
    try {
      binaryMonitor = await options.createBinaryResourceMonitor?.(child.pid, binaryInstanceId);
      await binaryMonitor?.start();
    } catch (error) {
      diagnostics?.log(`Traefik resource sampling unavailable: ${errorMessage(error)}`, {
        level: 'warn',
        source: { file: 'traefik/runtime.ts', function: 'runManagedTraefikService' },
      });
      binaryMonitor = undefined;
    }
    await waitForHealth(child, healthPort, settings.runtime.startupTimeoutMs, () => (logFailure ?? options.managedLogError?.())?.message ?? 'Traefik did not answer on its local health endpoint.');
    diagnostics?.log(`Traefik ${manifest.current} is healthy.`, { source: { file: 'traefik/runtime.ts', function: 'runManagedTraefikService' } });

    if (!options.controlServer) throw new Error('Traefik process did not receive a control server.');
    control = await startManagedControlServer({
      server: options.controlServer,
      ...options.controlIdentity,
      onStopError: (error) => {
        const message = `BRC managed shutdown failed: ${errorMessage(error)}`;
        diagnostics?.log(message, { level: 'error', error });
        console.error(message);
        managedLog?.write(message + '\n');
        process.exitCode = 1;
      },
      health: async () => {
        const failure = logFailure ?? options.managedLogError?.();
        if (failure) return { state: 'degraded', detail: `Traefik log output failed: ${failure.message}` };
        if (!child || child.exitCode !== null || child.signalCode !== null) return { state: 'degraded', detail: 'Traefik process exited.' };
        const status = await requestStatus(healthPort, '/ping');
        return status === 200
          ? { state: 'running', detail: `Traefik ${manifest.current} is healthy.` }
          : { state: 'degraded', detail: `Traefik /ping returned HTTP ${status}.` };
      },
      stop: async () => {
        stopping = true;
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
          if (!await waitForChildExit(child, settings.runtime.shutdownTimeoutMs)) throw new Error('Traefik did not stop after the managed shutdown request.');
        }
      },
    });
    if (!control) throw new Error('Traefik process did not receive a managed-control server.');
    const [exitCode, exitSignal] = await childClosed;
    if (!stopping) {
      process.exitCode = exitCode ?? 1;
      const message = `Traefik exited unexpectedly${exitSignal ? ` after ${exitSignal}` : ''}.`;
      console.error(message);
      managedLog?.write(message + '\n');
    }
  } catch (error) {
    process.exitCode = 1;
    diagnostics?.log(`Traefik service failed: ${errorMessage(error)}`, {
      level: 'error',
      error,
      source: { file: 'traefik/runtime.ts', function: 'runManagedTraefikService' },
    });
    console.error(`Traefik service failed: ${errorMessage(error)}`);
    managedLog?.write(`Traefik service failed: ${errorMessage(error)}\n`);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, settings.runtime.shutdownTimeoutMs);
    }
  } finally {
    await binaryMonitor?.stop().catch((error: unknown) => diagnostics?.log(`Traefik binary resource sampling stopped: ${errorMessage(error)}`, { level: 'warn' }));
    await control?.close();
    if (logSink && !logSink.destroyed) {
      logSink.end();
      await finished(logSink).catch(() => undefined);
    }
    await managedLog?.close();
  }
}
