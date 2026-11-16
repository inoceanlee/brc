#!/usr/bin/env node
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { appendRotatingLog, createDiagnosticsRuntime, DiagnosticSession, FileDiagnosticLog, FileSnapshotStore, FunctionTiming, installFunctionProbe, NodeResourceSampler, resolveSettings, startManagedControlServer, type ManagedControlServer } from 'brc-shared';
import { mountRelayRoutes } from './adapters/http/app.js';
import { loadConfig } from './adapters/http/config.js';
import { RelayOAuthProvider, RelayClientsStore } from './adapters/http/oauth-provider.js';
import { Sessions, HmacSessionSigner } from './adapters/http/sessions.js';
import { SessionPolicy } from './core/auth/sessions.js';
import { LoginLimiter } from './core/auth/rate-limit.js';
import { DeviceHub } from './adapters/transport/device-hub.js';
import { registerDeviceSocket } from './adapters/transport/websocket.js';
import { consentPage } from './adapters/http/pages/html.js';
import { SqliteStore, randomToken, sha256 } from './adapters/storage/sqlite.js';

const cfg = loadConfig();
const settings = resolveSettings({ version: 1 }, process.env).settings;
const diagnosticsDirectory = process.env.BRC_DIAGNOSTICS_DIR;
const diagnosticsEnabled = settings.diagnostics.enabled && !!diagnosticsDirectory;
const functionTiming = diagnosticsEnabled ? new FunctionTiming() : undefined;
if (functionTiming) {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./diagnostics-manifest.json', import.meta.url), 'utf8')) as {
      functions?: Array<{ id: string; name: string; file: string; line: number; kind: 'sync' | 'async' }>;
    };
    for (const entry of manifest.functions ?? []) functionTiming.register(entry.id, entry);
  } catch {}
}
const probe = functionTiming ? installFunctionProbe(functionTiming) : undefined;
const resourceSampler = diagnosticsEnabled
  ? new NodeResourceSampler({ intervalMs: settings.diagnostics.resourceSampleMs }) : undefined;
const diagnosticStore = diagnosticsEnabled
  ? new FileSnapshotStore({ directory: diagnosticsDirectory!, staleAfterMs: Math.max(settings.diagnostics.functionSnapshotMs * 3, 60_000) })
  : undefined;
const diagnosticSession = functionTiming && resourceSampler && diagnosticStore
  ? new DiagnosticSession({
    service: 'relay',
    instanceId: process.env.BRC_MANAGED_ID ?? String(process.pid),
    store: diagnosticStore,
    functions: functionTiming,
    resources: resourceSampler,
    snapshotIntervalMs: settings.diagnostics.functionSnapshotMs,
  }) : undefined;
const diagnostics = createDiagnosticsRuntime({
  enabled: diagnosticsEnabled,
  component: 'relay',
  instanceId: process.env.BRC_MANAGED_ID ?? String(process.pid),
  functions: functionTiming,
  resources: resourceSampler,
  session: diagnosticSession,
  log: diagnosticsEnabled && process.env.BRC_LOG_FILE
    ? new FileDiagnosticLog(path.join(path.dirname(process.env.BRC_LOG_FILE), 'relay-diagnostics.log'), {
      maxRecordBytes: settings.diagnostics.maxRecordBytes,
      maxBytes: settings.logs.rotateMiB * 1024 * 1024,
    }) : undefined,
});
const managedLogFile = process.env.BRC_LOG_FILE;
let pendingLogWrites = Promise.resolve();
function writeManagedLog(line: string): void {
  if (!managedLogFile) return;
  pendingLogWrites = pendingLogWrites.then(() =>
    appendRotatingLog(managedLogFile, line + '\n', settings.logs.rotateMiB * 1024 * 1024)
  ).catch(() => undefined);
}
async function closeLogs(): Promise<void> {
  await pendingLogWrites;
  await diagnostics.stop();
  probe?.uninstall();
}
if (process.argv.includes('--initialize')) {
  try {
    const input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8').trim();
    let administrator: { username: string; password: string } | undefined;
    if (input) {
      const candidate = JSON.parse(input) as { username?: unknown; password?: unknown };
      if (typeof candidate.username !== 'string' || !candidate.username.trim()
        || typeof candidate.password !== 'string' || candidate.password.length < 8) {
        throw new Error('Administrator setup requires a username and password of at least 8 characters.');
      }
      administrator = { username: candidate.username, password: candidate.password };
    }
    SqliteStore.initialize(cfg.dbFile);
    if (administrator) {
      const store = SqliteStore.open(cfg.dbFile);
      try { store.bootstrapAdministrator(administrator.username, administrator.password); }
      finally { store.close(); }
    }
  } catch (error) {
    console.error(`Relay database initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    await closeLogs();
    process.exit(1);
  }
  await closeLogs();
  process.exit(0);
}

const log = (level: string, msg: string) => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  diagnostics.log(msg, {
    level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
    source: { file: 'relay/cli.ts', function: 'log' },
  });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  writeManagedLog(line);
};

interface RelayInstance { http: HttpServer; close(): Promise<void> }
let relay: RelayInstance;
let relayStore: SqliteStore | undefined;
try {
  const store = SqliteStore.open(cfg.dbFile);
  relayStore = store;
  const admin = cfg.adminPassword ? store.upsertUser(cfg.adminUser, cfg.adminPassword) : store.getAdministrator();
  const sessionSecret = cfg.sessionSecret || store.getSessionSecret();
  const sessions = new Sessions(new SessionPolicy(new HmacSessionSigner(sessionSecret)), cfg.publicUrl.startsWith('https://'));
  const hub = new DeviceHub(cfg.relayVersion, log);
  const currentUser = (res: import('express').Response): string | null => {
    const userId = sessions.userId(res.req);
    return userId && store.getUser(userId) ? userId : null;
  };
  const tokens = { randomToken, sha256 };
  const clientsStore = new RelayClientsStore(store, tokens);
  const provider = new RelayOAuthProvider({
    store, tokens,
    currentUserId: currentUser,
    renderLogin: (res, returnTo) => res.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    renderConsent: (res, pendingId, client, scopes) => res.type('html').send(
      consentPage(pendingId, client.client_name ?? client.client_id, client.redirect_uris?.[0] ?? '', scopes),
    ),
    issuer: cfg.publicUrl,
  }, clientsStore);
  const limiter = new LoginLimiter();
  const app = express();
  mountRelayRoutes({ app, cfg, store, hub, sessions, provider, limiter, log });
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  registerDeviceSocket(http, wss, hub, store, cfg.publicUrl, log);
  const housekeeping = setInterval(() => store.vacuumExpired(cfg.audit), 10 * 60_000);
  housekeeping.unref();
  const authCleanup = setInterval(() => { provider.prunePending(); limiter.prune(); }, 60_000);
  authCleanup.unref();
  log('info', `admin user "${admin.username}" ready; db ${cfg.dbFile}`);
  relay = {
    http,
    close: async () => {
      clearInterval(housekeeping);
      clearInterval(authCleanup);
      hub.close();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      store.close();
    },
  };
} catch (error) {
  relayStore?.close();
  log('error', `Relay startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await closeLogs();
  process.exit(1);
}
const listening = once(relay.http, 'listening');
relay.http.listen(cfg.port, cfg.host);
await listening;
log('info', `brc-relay listening on ${cfg.host}:${cfg.port}`);
log('info', `public URL ${cfg.publicUrl}  MCP: ${cfg.publicUrl}/mcp  pair: ${cfg.publicUrl}/device/verify`);

let control: ManagedControlServer | undefined;
let stopping = false;
const stop = async (sig?: string) => {
  if (stopping) return;
  stopping = true;
  if (sig) log('info', `${sig} received, shutting down`);
  await control?.close();
  await relay.close();
  await closeLogs();
};
process.on('SIGINT', () => { void stop('SIGINT').catch((error: unknown) => log('error', String(error))); });
process.on('SIGTERM', () => { void stop('SIGTERM').catch((error: unknown) => log('error', String(error))); });
control = await startManagedControlServer({
  health: async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port}/health`);
      return response.ok
        ? { state: 'running', detail: 'Relay health endpoint is ready.' }
        : { state: 'degraded', detail: `Relay health returned HTTP ${response.status}.` };
    } catch {
      return { state: 'degraded', detail: 'Relay health endpoint is unavailable.' };
    }
  },
  stop: () => stop(),
});