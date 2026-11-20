// One-shot e2e runner: boots relay + agent on a scratch port/db, auto-pairs, runs all suites, tears down.
// pnpm test:e2e     (needs `pnpm build` first)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { TraefikManager } from '../packages/cli/dist/adapters/traefik/manager.js';

async function reservePorts(count, excluded = new Set()) {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < count) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not select a loopback port for e2e.');
      if (excluded.has(address.port) || ports.includes(address.port)) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        continue;
      }
      servers.push(server);
      ports.push(address.port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
  return ports;
}
const USE_TRAEFIK = Boolean(process.env.BRC_TRAEFIK_TEST_BINARY);
const PORT = Number(process.env.E2E_PORT ?? (await reservePorts(1))[0]);
const [RELAY_PORT, HEALTH_PORT] = USE_TRAEFIK
  ? await reservePorts(2, new Set([PORT]))
  : [PORT, undefined];
const base = `http://127.0.0.1:${PORT}`;
const pass = 'e2e-pass-' + Math.random().toString(36).slice(2, 8);
// realpath: Windows runners hand out 8.3 short paths (RUNNER~1) which crash libuv's fs.watch
const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-e2e-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayCli = path.resolve('packages/relay/dist/cli.js');
const agentCli = path.resolve('packages/agent/dist/cli.js');
const productVersion = JSON.parse(readFileSync(path.resolve('packages/cli/package.json'), 'utf8')).version;

function isolatedEnvironment(overrides = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('BRC_')));
  return { ...inherited, ...overrides };
}

function start(name, args, env, executable = process.execPath) {
  const p = spawn(executable, args, { env: isolatedEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${d}`); });
  p.stderr.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${d}`); });
  procs.push(p);
  return p;
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await sleep(400); }
  throw new Error(`timeout waiting for ${what}`);
}

function runScript(script, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { env: isolatedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timeout = setTimeout(() => {
      p.kill();
      reject(new Error(`${script} timed out after 30 seconds`));
    }, 30_000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.once('error', (error) => { clearTimeout(timeout); reject(error); });
    p.once('close', () => { clearTimeout(timeout); resolve(out); });
  });
}

let failed = 0;
try {
  const relayEnv = {
    PORT: String(RELAY_PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: base,
    BRC_ADMIN_PASSWORD: pass,
    BRC_SESSION_SECRET: 'e2e',
    BRC_DB: path.join(scratch, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(scratch, 'relay.log'),
    BRC_PRODUCT_VERSION: productVersion,
    BRC_LOG_ROTATE_MIB: '1',
    BRC_AUDIT_RETENTION_DAYS: String(DEFAULT_SETTINGS.audit.retentionDays),
    BRC_AUDIT_MAX_ENTRIES: String(DEFAULT_SETTINGS.audit.maxEntries),
    LOG_LEVEL: 'warn',
  };
  if (USE_TRAEFIK) {
    const paths = {
      root: scratch,
      traefik: path.join(scratch, 'traefik'),
      config: path.join(scratch, 'config'),
      data: path.join(scratch, 'data'),
      runtime: path.join(scratch, 'runtime'),
      logs: path.join(scratch, 'logs'),
      tmp: path.join(scratch, 'tmp'),
    };
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.services.relayPort = RELAY_PORT;
    settings.services.proxyPort = PORT;
    settings.services.healthPort = HEALTH_PORT;
    settings.proxy.rate.average = 5000;
    settings.proxy.rate.burst = 5000;
    settings.proxy.concurrent = 100;
    const manager = new TraefikManager(paths, settings, {
      status: async () => [],
      withLock: (operation) => operation({}),
    });
    await manager.writeConfig();
    const traefikConfig = path.join(paths.traefik, 'config', 'traefik.yml');
    start('traefik', ['--configFile', traefikConfig], {}, realpathSync.native(process.env.BRC_TRAEFIK_TEST_BINARY));
    await waitFor(async () => (await fetch(`http://127.0.0.1:${HEALTH_PORT}/ping`)).ok, 20_000, 'Traefik health');
    console.log(`official Traefik routes isolated E2E traffic through ${base}`);
  }
  const initialized = spawnSync(process.execPath, [relayCli, '--initialize'], {
    env: isolatedEnvironment(relayEnv),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (initialized.error) throw initialized.error;
  if (initialized.status !== 0) throw new Error(`Relay database initialization failed: ${initialized.stderr.trim() || initialized.stdout.trim()}`);
  const relay = start('relay', [relayCli], relayEnv);
  try {
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 20_000, 'relay');
  } catch (error) {
    const probe = async (url) => fetch(url).then(async (r) => ({
      status: r.status, body: (await r.text()).slice(0, 120),
    })).catch((e) => ({ error: e.message }));
    throw new Error(`Relay readiness check failed: ${JSON.stringify({
      relayExit: relay.exitCode,
      direct: await probe(`http://127.0.0.1:${RELAY_PORT}/health`),
      throughTraefik: await probe(`${base}/health`),
    })}`, { cause: error });
  }

  const agent = start('agent', [agentCli, 'connect', '--relay', base, '--name', 'e2e-agent', '--no-browser'], { BRC_DATA_ROOT: path.join(scratch, 'agent-data'), BRC_PRODUCT_VERSION: productVersion });
  const code = await waitFor(() => agent.out.match(/code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1], 20_000, 'pairing code');

  let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: pass, returnTo: '/' }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  r = await fetch(`${base}/device/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user_code: code, decision: 'allow' }) });
  if (r.status !== 200) throw new Error(`approve failed: ${r.status}`);
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).devices === 1, 20_000, 'agent online');
  console.log(`${USE_TRAEFIK ? 'Relay and Agent are reachable through isolated Traefik' : 'relay + agent up'} on ${base} (pairing code ${code})\n`);
  relay.kill('SIGTERM');
  await waitFor(() => relay.exitCode !== null || relay.signalCode !== null, 5000, 'relay shutdown');
  start('relay', [relayCli], relayEnv);
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 20_000, 'relay restart');
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).devices === 1, 20_000, 'agent reconnect after relay restart');
  console.log(`${USE_TRAEFIK ? 'Agent WebSocket reconnected through Traefik' : 'Agent reconnected'} after Relay restart with existing database identity.`);

  // rate-limit test must run last: it locks the admin login for 5 minutes.
  for (const s of ['scripts/e2e-oauth.mjs', 'scripts/e2e-admin.mjs']) {
    console.log(`== ${s}`);
    const out = await runScript(s, base, 'admin', pass);
    process.stdout.write(out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => '  ' + l.slice(0, 110)).join('\n') + '\n');
    const f = (out.match(/^FAIL/gm) ?? []).length;
    if (f || !/^PASS/m.test(out)) { failed += f || 1; if (!/^PASS/m.test(out)) console.log('  (suite crashed)\n' + out.slice(-600)); }
  }
} catch (e) {
  failed++;
  console.error('runner error:', e instanceof Error ? e.message : e);
  for (const p of procs) if (p.out) console.error(p.out.slice(-800));
  try { console.error('relay log:', readFileSync(path.join(scratch, 'relay.log'), 'utf8').slice(-5000)); } catch {}
} finally {
  if (failed) for (const p of procs) if (p.out) console.error(`\n--- ${p.spawnargs?.[1]?.split(/[\\/]/).slice(-3).join('/')} output ---\n${p.out.slice(-3000)}`);
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(500);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : '\nall e2e suites passed');
process.exit(failed ? 1 : 0);
