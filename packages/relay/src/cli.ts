#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { appendRotatingLog, createDiagnosticsRuntime, DiagnosticSession, FunctionTiming, installFunctionProbe, clearEarlyProbe, NodeResourceSampler, SqliteDiagnosticsStore, diagnosticsRetentionConfig, resolveDiagnosticsDbPath, resolveSettings, snapshotStaleAfterMs, startManagedControlServer, type ManagedControlServer, type TextLogPort } from 'brc-shared';
import { mountRelayRoutes } from './adapters/http/app.js';
import { loadConfig } from './adapters/http/config.js';
import { RelayOAuthProvider, RelayClientsStore } from './adapters/http/oauth-provider.js';
import { Sessions, HmacSessionSigner } from './adapters/http/sessions.js';
import { SessionPolicy } from './core/auth/sessions.js';
import { LoginLimiter } from './core/auth/rate-limit.js';
import { DeviceHub } from './adapters/transport/device-hub.js';
import { registerDeviceSocket } from './adapters/transport/websocket.js';
import { consentPage } from './adapters/http/pages/html.js';
import { SqliteStore, randomToken, sha256, verifyPassword } from './adapters/storage/sqlite.js';
import { RelayAuditLog } from './adapters/storage/relay-audit.js';

const cfg = loadConfig();
const settings = resolveSettings({ version: 1 }, process.env).settings;
const diagnosticsDirectory = process.env.BRC_DIAGNOSTICS_DIR;
const diagnosticsEnabled = settings.diagnostics.enabled && !!diagnosticsDirectory;
const functionTiming = diagnosticsEnabled ? new FunctionTiming() : undefined;
if (functionTiming) {
  for (const url of [
    new URL('./diagnostics-manifest.json', import.meta.url),
    new URL('./diagnostics-manifest.json', import.meta.resolve('brc-shared')),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(url, 'utf8')) as {
        functions?: Array<{ id: string; name: string; file: string; line: number; kind: 'sync' | 'async' }>;
      };
      for (const entry of manifest.functions ?? []) functionTiming.register(entry.id, entry);
    } catch {}
  }
}
const probe = functionTiming ? installFunctionProbe(functionTiming) : undefined;
if (!probe) clearEarlyProbe();
const resourceSampler = diagnosticsEnabled
  ? new NodeResourceSampler({ intervalMs: settings.diagnostics.resourceSampleMs }) : undefined;
const diagnosticStore = diagnosticsEnabled
  ? new SqliteDiagnosticsStore({
    databasePath: resolveDiagnosticsDbPath(path.dirname(path.resolve(cfg.dbFile)), process.env),
    config: diagnosticsRetentionConfig(settings),
    staleAfterMs: snapshotStaleAfterMs(settings.diagnostics.functionSnapshotMs),
  })
  : undefined;
const diagnosticSession = functionTiming && resourceSampler && diagnosticStore
  ? new DiagnosticSession({
    service: 'relay',
    instanceId: process.env.BRC_MANAGED_ID ?? String(process.pid),
    store: diagnosticStore.snapshots,
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
  log: diagnosticStore?.log,
});
const managedLogFile = process.env.BRC_LOG_FILE;
let pendingLogWrites = Promise.resolve();
let managedLogFailure: Error | undefined;
function writeManagedLog(line: string): void {
  if (!managedLogFile) return;
  pendingLogWrites = pendingLogWrites.then(() =>
    appendRotatingLog(managedLogFile, line + '\n', settings.logs.rotateMiB * 1024 * 1024)
  ).catch((error: unknown) => { managedLogFailure ??= error instanceof Error ? error : new Error(String(error)); });
}
async function closeLogs(): Promise<void> {
  const errors: unknown[] = [];
  await pendingLogWrites;
  try { await diagnostics.stop(); } catch (error) { errors.push(error); }
  try { diagnosticStore?.close(); } catch (error) { errors.push(error); }
  try { probe?.uninstall(); } catch (error) { errors.push(error); }
  if (managedLogFailure) errors.push(managedLogFailure);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Relay log shutdown failed.');
}
const log = (level: string, msg: string): void => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  diagnostics.log(msg, {
    level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
    source: { file: 'relay/cli.ts', function: 'log' },
  });
  console.error(line);
  writeManagedLog(line);
};
const textLog: TextLogPort = {
  error: (message) => log('error', message),
  warning: (message) => log('warn', message),
  info: (message) => log('info', message),
};
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
    const legacyFile = process.env.BRC_LEGACY_RELAY_DB;
    const hadLegacy = Boolean(legacyFile && existsSync(legacyFile));
    let importedLegacy = false;
    if (hadLegacy && legacyFile) {
      const audit = RelayAuditLog.open({ dbFile: cfg.dbFile, env: process.env, settings });
      try { await audit.importLegacyAudit(legacyFile); }
      finally { audit.close(); }
      importedLegacy = true;
    }
    SqliteStore.initialize(cfg.dbFile, legacyFile || undefined, textLog);
    if (administrator && !importedLegacy) {
      const store = SqliteStore.open(cfg.dbFile);
      try { store.bootstrapAdministrator(administrator.username, administrator.password); }
      finally { store.close(); }
    }
  } catch (error) {
    console.error(`Relay database initialization failed: ${error instanceof Error ? error.message : String(error)}\nRun: brc setup`);
    await closeLogs();
    process.exit(1);
  }
  await closeLogs();
  process.exit(0);
}

interface RelayInstance { http: HttpServer; close(): Promise<void> }
let relay: RelayInstance;
let relayStore: SqliteStore | undefined;
let relayAudit: RelayAuditLog | undefined;
try {
  const audit = RelayAuditLog.open({ dbFile: cfg.dbFile, env: process.env, settings });
  relayAudit = audit;
  const store = SqliteStore.open(cfg.dbFile, audit);
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
  const limiter = new LoginLimiter(cfg.auth.maxFails, cfg.auth.lockMs);
  const app = express();
  mountRelayRoutes({ app, cfg, store, audit, hub, sessions, provider, limiter, log, verifyPassword });
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
      const errors: unknown[] = [];
      try { clearInterval(housekeeping); } catch (error) { errors.push(error); }
      try { clearInterval(authCleanup); } catch (error) { errors.push(error); }
      try { hub.close(); } catch (error) { errors.push(error); }
      try { wss.close(); } catch (error) { errors.push(error); }
      try {
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      } catch (error) { errors.push(error); }
      try { store.close(); } catch (error) { errors.push(error); }
      try { audit.close(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Relay resource shutdown failed.');
    },
  };
} catch (error) {
  relayStore?.close();
  relayAudit?.close();
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
let stopping: Promise<void> | undefined;
const stop = (sig?: string): Promise<void> => stopping ??= (async () => {
  const errors: unknown[] = [];
  if (sig) log('info', `${sig} received, shutting down`);
  try { await relay.close(); } catch (error) { errors.push(error); }
  try { await closeLogs(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join('; '));
})();
const stopForSignal = (signal: string) => {
  void (async () => {
    try { await stop(signal); } catch (error) { process.stderr.write(`Relay shutdown failed: ${String(error)}\n`); }
    try { await control?.close(); } catch (error) { process.stderr.write(`Relay control shutdown failed: ${String(error)}\n`); }
  })();
};
process.on('SIGINT', () => stopForSignal('SIGINT'));
process.on('SIGTERM', () => stopForSignal('SIGTERM'));
control = await startManagedControlServer({
  server: createServer(),
  shutdownTimeoutMs: settings.runtime.shutdownTimeoutMs,
  token: process.env.BRC_CONTROL_TOKEN,
  readyFile: process.env.BRC_CONTROL_READY_FILE,
  id: process.env.BRC_MANAGED_ID,
  service: process.env.BRC_MANAGED_SERVICE,
  onStopError: (error) => {
    process.stderr.write(`BRC managed shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
  health: async () => {
    const failure = diagnostics.getLogFailure() ?? managedLogFailure;
    if (failure) return { state: 'degraded', detail: `Relay log output failed: ${failure.message}` };
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