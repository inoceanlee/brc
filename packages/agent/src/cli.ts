#!/usr/bin/env node
/**
 * BRC agent CLI.
 *   brc-agent --relay https://rdp.example.com [--name "My PC"] [--no-browser] [--debug]
 *   brc-agent --logout                 remove saved credentials
 *   brc-agent --relay <url> --token <t> --device-id <id>   (dev: skip pairing, pre-issued token)
 * Env: BRC_RELAY, BRC_NAME, BRC_TOKEN, BRC_DEVICE_ID, BRC_HOME, BRC_DEBUG
 */
import os from 'node:os';
import path from 'node:path';
import { applyLegacyEnv, installManagedLog, startDiagnostics, startManagedControlServer, type ManagedControlServer } from 'brc-shared';
applyLegacyEnv();
const managedLog = installManagedLog();
const diagnostics = await startDiagnostics({
  component: 'agent',
  manifestUrl: new URL('./diagnostics-manifest.json', import.meta.url),
  logFile: process.env.BRC_LOG_FILE
    ? path.join(path.dirname(process.env.BRC_LOG_FILE), 'agent-diagnostics.log')
    : undefined,
});
import { WsClient } from './transport/ws-client.js';
import { pairDevice, loadCredentials, clearCredentials, type DeviceCredentials } from './transport/pairing.js';
import { callTool, listTools } from './dispatcher.js';
import { VERSION } from './core/version.js';
import { setCurrentClient } from './context.js';


function arg(name: string, env?: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return (env && process.env[env]) || def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function exitWithCode(code: number): Promise<never> {
  await diagnostics.stop();
  await managedLog?.close();
  process.exit(code);
}

const debug = flag('debug') || process.env.BRC_DEBUG === '1';
const ts = () => new Date().toISOString();
const log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
  if (level === 'debug' && !debug) return;
  diagnostics.log(msg, { level, source: { file: 'agent/cli.ts', function: 'log' } });
  (level === 'error' ? console.error : console.log)(`[${ts()}] [${level}] ${msg}`);
};

if (flag('logout')) {
  console.log(clearCredentials() ? 'Credentials removed.' : 'No saved credentials.');
  await exitWithCode(0);
}
if (flag('install-service') || flag('uninstall-service')) {
  const { installService, uninstallService } = await import('./service.js');
  try {
    if (flag('uninstall-service')) { console.log(uninstallService()); await exitWithCode(0); }
    if (!loadCredentials()) { console.error('Pair first: run the agent once interactively with --relay <url>, then --install-service.'); await exitWithCode(2); }
    // Service uses saved credentials; only pass through policy/debug flags.
    const keep = new Set(['--debug', '--allow-dir']);
    const passthrough: string[] = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (!keep.has(argv[i])) continue;
      passthrough.push(argv[i]);
      if (argv[i] === '--allow-dir' && argv[i + 1]) passthrough.push(argv[++i]);
    }
    console.log(installService(passthrough));
  } catch (e) { console.error(`Service setup failed: ${e instanceof Error ? e.message : String(e)}`); await exitWithCode(1); }
  await exitWithCode(0);
}

// --allow-dir <path> (repeatable): restrict tools to these directories (agent-side policy, persisted in config)
const allowDirs = process.argv.flatMap((a, i, all) => (a === '--allow-dir' && all[i + 1] ? [all[i + 1]] : []));
if (allowDirs.length) {
  const { configManager } = await import('./core/config-manager.js');
  await configManager.setValue('allowedDirectories', allowDirs);
  console.log(`allowedDirectories set to: ${allowDirs.join(', ')}`);
}

let client: WsClient | undefined;
let control: ManagedControlServer | undefined;
let awaitingPairing = false;
let stopping = false;
const shutdown = async (sig?: string) => {
  if (stopping) return;
  stopping = true;
  if (sig) console.log(`\n${sig} received, stopping agent`);
  client?.stop();
  await control?.close();
  setTimeout(() => {
    void (managedLog?.close() ?? Promise.resolve()).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }, 200);
};
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
control = await startManagedControlServer({
  health: () => awaitingPairing
    ? { state: 'pairing', detail: 'Agent awaits device approval; run brc logs agent.' }
    : client?.connected
      ? { state: 'running', detail: 'Agent connected to Relay.' }
      : { state: 'degraded', detail: 'Agent is not connected to Relay.' },
  stop: () => shutdown(),
});

async function resolveCredentials(): Promise<DeviceCredentials> {
  const relayArg = arg('relay', 'BRC_RELAY');
  const name = arg('name', 'BRC_NAME', os.hostname())!;
  const token = arg('token', 'BRC_TOKEN');
  const deviceId = arg('device-id', 'BRC_DEVICE_ID');

  if (token) {
    if (!relayArg || !deviceId) { console.error('--token requires --relay and --device-id'); return await exitWithCode(2); }
    return { relayUrl: relayArg.replace(/\/$/, ''), deviceId, deviceToken: token, name, pairedAt: 'manual' };
  }

  const saved = loadCredentials();
  if (saved && (!relayArg || saved.relayUrl === relayArg.replace(/\/$/, ''))) {
    log('info', `Using saved credentials for ${saved.relayUrl} as "${saved.name}" [${saved.deviceId}]`);
    return saved;
  }
  if (!relayArg) {
    console.error('No saved credentials. Usage: brc-agent --relay <url> [--name <name>]');
    return await exitWithCode(2);
  }
  awaitingPairing = true;
  try {
    const browserAllowed = !flag('no-browser') && process.env.BRC_NO_BROWSER !== '1';
    return await pairDevice({ relayUrl: relayArg, name, deviceId, openBrowser: browserAllowed, log: (m) => console.log(m) });
  } finally {
    awaitingPairing = false;
  }
}

const creds = await resolveCredentials();
setCurrentClient({ name: 'brc-agent', version: VERSION });
const tools = listTools();
console.log(`brc-agent - ${tools.length} tools - "${creds.name}" [${creds.deviceId}] -> ${creds.relayUrl}`);

const start = (c: DeviceCredentials) => {
  client = new WsClient({
    relayUrl: c.relayUrl, token: c.deviceToken, deviceId: c.deviceId, name: c.name,
    agentVersion: VERSION, coreVersion: VERSION, tools, callTool, log,
    onUnauthorized: async () => {
      if (c.pairedAt === 'manual') return false;
   log('error', 'Relay rejected the saved device token; credentials remain unchanged. Pair explicitly after checking device ownership.');
   return false;
    },
  });
  client.start();
};
start(creds);
