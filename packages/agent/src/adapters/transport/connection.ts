import os from 'node:os';
import type { Server } from 'node:http';
import { startManagedControlServer, type InjectedDiagnosticsRuntime, type ManagedControlServer, type SettingsStorePort } from 'brc-shared';
import type { WsClient, WsClientOptions } from './ws-client.js';
import { pairDevice, type DeviceCredentials } from './pairing.js';
import { VERSION } from '../../core/version.js';
import { AGENT_DEFAULTS } from '../../core/config.js';
import type { AgentPaths } from '../storage/agent-paths.js';
import type { AgentLogger, LogLevel } from '../telemetry/logger.js';
import type { AgentInvocation } from '../../commands/parser.js';
import { AgentUsageError } from '../../commands/parser.js';
import { readTokenFromStdin } from '../terminal/secret-input.js';
import { resolveAgentSettings, type AgentConfigManager } from '../storage/config-manager.js';
import type { ToolHistory } from '../telemetry/toolHistory.js';
import type { ToolDispatcher } from '../mcp/dispatcher.js';
import type { AgentContext } from '../../context.js';
import type { SearchManager } from '../system/search-manager.js';

export interface AgentConnectionServices {
  paths: AgentPaths;
  createClient(options: WsClientOptions): WsClient;
  logger: AgentLogger;
  env: NodeJS.ProcessEnv;
  settingsStore: SettingsStorePort;
  credentials: {
    load(): DeviceCredentials | null;
    save(credentials: DeviceCredentials): void;
    filename: string;
  };
  searchManager: SearchManager;
  bindHistoryFailureReporter(report: (message: string) => void): () => void;
  configManager: AgentConfigManager;
  toolHistory: ToolHistory;
  dispatcher: ToolDispatcher;
  context: AgentContext;
}
export async function flushAgentHistory(
  history: Pick<ToolHistory, 'cleanup'>,
  report: (message: string) => void,
  timeoutMs = AGENT_DEFAULTS.historyFlushTimeoutMs,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      history.cleanup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('History flush timed out.'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    report(timedOut ? 'Agent history flush timed out.' : 'Agent history flush failed.');
  } finally {
    clearTimeout(timer);
  }
}


function validateRelay(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new AgentUsageError('Relay must be an HTTP(S) URL without credentials.');
  }
  return url.toString().replace(/\/$/, '');
}

export async function runAgentConnection(
  inv: AgentInvocation,
  services: AgentConnectionServices,
  diagnostics: InjectedDiagnosticsRuntime,
  controlServer: Server,
  onReady?: () => void,
): Promise<void> {
  if (inv.offline) throw new AgentUsageError('Connecting requires network access; remove --offline.');
  const relayArg = inv.relay || services.env.BRC_RELAY;
  const name = inv.name || services.env.BRC_NAME || os.hostname();
  const deviceId = inv.deviceId || services.env.BRC_DEVICE_ID;
  const token = inv.tokenStdin ? await readTokenFromStdin() : services.env.BRC_TOKEN;
  if (inv.tokenStdin && services.env.BRC_TOKEN) throw new AgentUsageError('Choose either BRC_TOKEN or --token-stdin.');
  if (token && (!relayArg || !deviceId)) {
    throw new AgentUsageError('BRC_TOKEN or --token-stdin also requires --relay and --device-id.');
  }
  const saved = !token ? services.credentials.load() : null;
  if (!token && !relayArg && !saved) throw new AgentUsageError('No saved device credentials. Specify --relay to pair.');
  const relay = relayArg ? validateRelay(relayArg) : undefined;
  const manual = token && relay && deviceId
    ? { relayUrl: relay, deviceId, deviceToken: token, name, pairedAt: 'manual' }
    : undefined;
  if (inv.allowDirectories.length) {
    await services.configManager.setUserSetting('allowedDirectories', inv.allowDirectories);
  }
  const unbindLog = services.logger.bind((level: LogLevel, message: string) => {
    const severity = level === 'warning' ? 'warn' : ['emergency', 'alert', 'critical', 'error'].includes(level) ? 'error' : level === 'debug' ? 'debug' : 'info';
    diagnostics.log(message, { level: severity, source: { file: 'agent/logger.ts', function: 'log' } });
    if (severity === 'error') process.stderr.write('[agent:error] ' + message + '\n');
  });
  let controlStarting: Promise<ManagedControlServer | undefined> | undefined;
  let client: WsClient | undefined;
  let awaitingPairing = false;
  let stopPromise: Promise<void> | undefined;
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
    if (level === 'debug' && !inv.debug) return;
    diagnostics.log(message, { level, source: { file: 'agent/connection.ts', function: 'log' } });
    if (!inv.quiet || level === 'error') process.stderr.write('[' + level + '] ' + message + '\n');
  };
  let historyFailure: string | undefined;
  const unbindHistoryFailure = services.bindHistoryFailureReporter((message) => {
    historyFailure ??= message;
    log('error', message);
  });
  const abort = new AbortController();
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    const errors: unknown[] = [];
    abort.abort(new Error('Agent shutdown requested.'));
    const pendingCalls = Promise.allSettled([services.dispatcher.stop(), services.searchManager.stop()]);
    try { await client?.stop(); } catch (error) {
      const timeout = error instanceof Error && error.message === 'Agent WebSocket did not close before the shutdown deadline.';
      errors.push(new Error(timeout ? error.message : 'Agent WebSocket shutdown failed.'));
    }
    let drainTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pendingCalls.then((results) => {
          if (results[0].status === 'rejected') {
            const failure = results[0].reason;
            const usageFailure = failure instanceof AggregateError && failure.errors.length > 0
              && failure.errors.every((item: unknown) => item instanceof Error && item.message === 'Agent usage storage write failed.');
            errors.push(new Error(usageFailure ? 'Agent usage storage write failed.' : 'Agent tool shutdown failed.'));
          }
          if (results[1].status === 'rejected') errors.push(new Error('Agent search shutdown failed.'));
        }),
        new Promise<never>((_, reject) => {
          drainTimer = setTimeout(() => reject(new Error('Agent tool shutdown timed out.')), AGENT_DEFAULTS.historyFlushTimeoutMs);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(drainTimer);
    }
    try {
      await flushAgentHistory(services.toolHistory, (message) => {
        log('error', message);
        errors.push(new Error(message));
      });
    } catch { errors.push(new Error('Agent history flush failed.')); }
    if (historyFailure) errors.push(new Error(historyFailure));
    try { await diagnostics.stop(); } catch { errors.push(new Error('Agent diagnostics shutdown failed.')); }
    unbindHistoryFailure();
    unbindLog();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join('; '));
  })();
  const stopForSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    void (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          stop(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Agent shutdown timed out.')), AGENT_DEFAULTS.historyFlushTimeoutMs);
          }),
        ]);
      } catch (error) {
        process.stderr.write(`Agent shutdown failed: ${String(error)}\n`);
      } finally {
        clearTimeout(timer);
      }
      try {
        await Promise.race([
          (async () => { await (await controlStarting)?.close(); })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Agent control startup or closure timed out.')), AGENT_DEFAULTS.historyFlushTimeoutMs);
          }),
        ]);
      } catch {
        process.stderr.write('Agent control shutdown failed.\n');
      } finally {
        clearTimeout(timer);
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', () => stopForSignal('SIGINT'));
  process.once('SIGTERM', () => stopForSignal('SIGTERM'));
  try {
    const settings = resolveAgentSettings((await services.settingsStore.read()).settings, services.env);
    controlStarting = startManagedControlServer({
      server: controlServer,
      shutdownTimeoutMs: settings.runtime.shutdownTimeoutMs,
      token: services.env.BRC_CONTROL_TOKEN,
      readyFile: services.env.BRC_CONTROL_READY_FILE,
      id: services.env.BRC_MANAGED_ID,
      service: services.env.BRC_MANAGED_SERVICE,
      onStopError: (error) => {
        process.stderr.write(`BRC managed shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
      health: () => {
        const failure = diagnostics.getLogFailure();
        if (failure) return { state: 'degraded', detail: 'Agent diagnostic logging failed.' };
        return awaitingPairing
          ? { state: 'pairing', detail: 'Agent awaits pairing approval.' }
          : client?.connected
            ? { state: 'running', detail: 'Agent connected to Relay.' }
            : { state: 'degraded', detail: 'Agent is not connected to Relay.' };
      },
      stop: () => stop(),
    });
    await controlStarting;
    onReady?.();
    let creds: DeviceCredentials;
    if (manual) creds = manual;
    else if (saved && (!relay || saved.relayUrl === relay)) {
      creds = saved;
      log('info', 'Using saved device credentials.');
    } else {
      if (!relay) throw new AgentUsageError('No Relay URL was provided.');
      awaitingPairing = true;
      try {
        creds = await pairDevice({
          relayUrl: relay, name, deviceId, openBrowser: !inv.noBrowser && services.env.BRC_NO_BROWSER !== '1',
          log: (message) => process.stderr.write(message + '\n'), signal: abort.signal, credentials: services.credentials,
        });
      } finally {
        awaitingPairing = false;
      }
    }
    if (abort.signal.aborted) return;
    const tools = services.dispatcher.listTools();
    log('info', 'BRC Agent connecting ' + tools.length + ' tool definitions to ' + creds.relayUrl + '.');
    client = services.createClient({
      relayUrl: creds.relayUrl, token: creds.deviceToken, deviceId: creds.deviceId, name: creds.name,
      agentVersion: VERSION, coreVersion: VERSION, tools,
      callTool: (tool, args, client) => services.context.runRemote(client ?? null, () => services.dispatcher.callTool(tool, args)),
      log,
      onUnauthorized: async () => {
        log('error', 'Relay rejected the saved device token; credentials remain unchanged. Pair explicitly after checking device ownership.');
        return false;
      },
    });
    client.start();
  } catch (error) {
    const shutdownRequested = abort.signal.aborted;
    const errors: unknown[] = [];
    try { await stop(); } catch (shutdownError) { errors.push(shutdownError); }
    if (!shutdownRequested) {
      try { await (await controlStarting)?.close(); } catch { errors.push(new Error('Agent control shutdown failed.')); }
    }
    if (errors.length) {
      const detail = errors.map((item) => item instanceof Error ? item.message : 'Agent shutdown failed.').join('; ');
      throw new AggregateError([new Error('Agent startup failed.'), ...errors], `Agent startup failed; Agent shutdown failed: ${detail}`);
    }
    if (!shutdownRequested) throw error;
  }
}
