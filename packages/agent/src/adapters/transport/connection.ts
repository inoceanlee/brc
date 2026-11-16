import os from 'node:os';
import type { Server } from 'node:http';
import { startManagedControlServer, type InjectedDiagnosticsRuntime, type ManagedControlServer } from 'brc-shared';
import { WsClient } from './ws-client.js';
import { pairDevice, loadCredentials, type DeviceCredentials } from './pairing.js';
import { callTool, listTools } from '../mcp/dispatcher.js';
import { VERSION } from '../../core/version.js';
import { setCurrentClient } from '../../context.js';
import { installAgentLogSink, type LogLevel } from '../telemetry/logger.js';
import type { AgentInvocation } from '../../commands/parser.js';
import { AgentUsageError } from '../../commands/parser.js';
import { readTokenFromStdin } from '../terminal/secret-input.js';

function validateRelay(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new AgentUsageError('Relay must be an HTTP(S) URL without credentials.');
  }
  return url.toString().replace(/\/$/, '');
}

export async function runAgentConnection(
  inv: AgentInvocation,
  diagnostics: InjectedDiagnosticsRuntime,
  controlServer: Server,
  controlIdentity: { token?: string; readyFile?: string; id?: string; service?: string },
): Promise<void> {
  if (inv.offline) throw new AgentUsageError('Connecting requires network access; remove --offline.');
  const relayArg = inv.relay || process.env.BRC_RELAY;
  const name = inv.name || process.env.BRC_NAME || os.hostname();
  const deviceId = inv.deviceId || process.env.BRC_DEVICE_ID;
  const token = inv.tokenStdin ? await readTokenFromStdin() : process.env.BRC_TOKEN;
  if (inv.tokenStdin && process.env.BRC_TOKEN) throw new AgentUsageError('Choose either BRC_TOKEN or --token-stdin.');
  if (token && (!relayArg || !deviceId)) {
    throw new AgentUsageError('BRC_TOKEN or --token-stdin also requires --relay and --device-id.');
  }
  const saved = !token ? loadCredentials() : null;
  if (!token && !relayArg && !saved) throw new AgentUsageError('No saved device credentials. Specify --relay to pair.');
  const relay = relayArg ? validateRelay(relayArg) : undefined;
  const manual = token && relay && deviceId
    ? { relayUrl: relay, deviceId, deviceToken: token, name, pairedAt: 'manual' }
    : undefined;
  if (inv.allowDirectories.length) {
    const { configManager } = await import('../storage/config-manager.js');
    await configManager.setUserSetting('allowedDirectories', inv.allowDirectories);
  }
  const unbindLog = installAgentLogSink((level: LogLevel, message: string) => {
    const severity = level === 'warning' ? 'warn' : ['emergency', 'alert', 'critical', 'error'].includes(level) ? 'error' : level === 'debug' ? 'debug' : 'info';
    diagnostics.log(message, { level: severity, source: { file: 'agent/logger.ts', function: 'log' } });
  });
  let control: ManagedControlServer | undefined;
  let client: WsClient | undefined;
  let awaitingPairing = false;
  let stopping = false;
  const log = (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
    if (level === 'debug' && !inv.debug) return;
    diagnostics.log(message, { level, source: { file: 'agent/connection.ts', function: 'log' } });
    if (!inv.quiet || level === 'error') process.stderr.write('[' + level + '] ' + message + '\n');
  };
  const abort = new AbortController();
  const stop = async (signal?: 'SIGINT' | 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    abort.abort(new Error('Agent shutdown requested.'));
    client?.stop();
    try {
      await control?.close();
      await diagnostics.stop();
    } finally {
      unbindLog();
      if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  try {
    control = await startManagedControlServer({
      server: controlServer,
      ...controlIdentity,
      health: () => awaitingPairing
        ? { state: 'pairing', detail: 'Agent awaits pairing approval.' }
        : client?.connected
          ? { state: 'running', detail: 'Agent connected to Relay.' }
          : { state: 'degraded', detail: 'Agent is not connected to Relay.' },
      stop: () => stop(),
    });
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
          relayUrl: relay, name, deviceId, openBrowser: !inv.noBrowser && process.env.BRC_NO_BROWSER !== '1',
          log: (message) => process.stderr.write(message + '\n'), signal: abort.signal,
        });
      } finally {
        awaitingPairing = false;
      }
    }
    if (abort.signal.aborted) return;
    setCurrentClient({ name: 'brc-agent', version: VERSION });
    const tools = listTools();
    log('info', 'BRC Agent connecting ' + tools.length + ' tool definitions to ' + creds.relayUrl + '.');
    client = new WsClient({
      relayUrl: creds.relayUrl, token: creds.deviceToken, deviceId: creds.deviceId, name: creds.name,
      agentVersion: VERSION, coreVersion: VERSION, tools, callTool, log,
      onUnauthorized: async () => {
        log('error', 'Relay rejected the saved device token; credentials remain unchanged. Pair explicitly after checking device ownership.');
        return false;
      },
    });
    client.start();
  } catch (error) {
    await stop();
    throw error;
  }
}
