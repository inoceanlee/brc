// Windows: node scripts/benchmark-cli.mjs <absolute-official-traefik-executable>
// Reuse the same isolated root and ports: node scripts/benchmark-cli.mjs --reuse <root>
// Run only the diagnostic cycle: node scripts/benchmark-cli.mjs --diagnostics-only --reuse <root>
// Install dependencies and build all workspace packages in this worktree first.
// This uses the local CLI, not a global package. It never removes its temporary root.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isolatedEnvironment, isAllowedPort, summarize } from './benchmark-cli-helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'packages', 'cli', 'dist', 'cli.js');
const preload = path.join(repo, 'scripts', 'benchmark-cli-phases.mjs');
const diagnosticsOnly = process.argv[2] === '--diagnostics-only';
const argOffset = diagnosticsOnly ? 3 : 2;
const reuse = process.argv[argOffset] === '--reuse';
const argument = process.argv[argOffset + (reuse ? 1 : 0)];
if (process.platform !== 'win32' || (diagnosticsOnly && !reuse) || !argument || !path.isAbsolute(argument) || process.argv.length !== argOffset + (reuse ? 2 : 1)) {
  throw new Error('Windows only. Supply an absolute official Traefik path, or [--diagnostics-only] --reuse followed by an existing benchmark root.');
}

async function reservePorts() {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < 3) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to allocate loopback port.');
      if (!isAllowedPort(address.port, ports)) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        continue;
      }
      servers.push(server);
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const ms = performance.now() - started;
      if (code !== 0) reject(new Error(`${path.basename(executable)} ${args.join(' ')} failed (code ${code}, signal ${signal}): ${stderr || stdout}`));
      else resolve({ ms, stdout, stderr });
    });
  });
}

const temp = await realpath(tmpdir());
let scratch;
let ports;
let metadata;
if (reuse) {
  scratch = await realpath(argument);
  if (path.dirname(scratch).toLowerCase() !== temp.toLowerCase() || !path.basename(scratch).startsWith('brc-benchmark-')) {
    throw new Error('Reuse is limited to an existing brc-benchmark-* directory directly inside the system temporary directory.');
  }
  metadata = JSON.parse(await readFile(path.join(scratch, 'benchmark-fixture.json'), 'utf8'));
  ports = metadata.ports;
  if (metadata.version !== 1 || !Array.isArray(ports) || ports.length !== 3 || ports.some((p, i) => !Number.isInteger(p) || p < 1024 || p > 65535 || !isAllowedPort(p, ports.slice(0, i)))) {
    throw new Error('Invalid benchmark fixture metadata.');
  }
} else {
  scratch = await mkdtemp(path.join(temp, 'brc-benchmark-'));
  ports = await reservePorts();
}
const env = isolatedEnvironment(process.env, scratch, ports);
await mkdir(env.TEMP, { recursive: true });
console.log(`Isolated benchmark data: ${scratch}`);
console.log(`Loopback ports: ${ports.join(', ')}`);
const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const reportFile = path.join(scratch, `benchmark-${runId}.json`);
const phaseFile = path.join(scratch, `benchmark-${runId}-phases.jsonl`);
const report = { root: scratch, ports, samples: {}, phases: { file: phaseFile, note: 'Separate instrumented cycle; nested phase times overlap. Cleanup and standalone identity query timings are not exposed by the CLI.' } };
const cliRun = (command, diagnostic = false) => run(process.execPath, diagnostic ? ['--import', pathToFileURL(preload).href, cli, command] : [cli, command], diagnostic ? { ...env, BENCHMARK_PHASE_FILE: phaseFile } : env);
async function assertState(expected) {
  const result = await cliRun('status');
  for (const service of ['relay', 'traefik', 'agent']) {
    if (!new RegExp(`^${service}: ${expected}(?:\\s|$)`, 'm').test(result.stdout)) {
      throw new Error(`Expected ${service} ${expected}, got status:\n${result.stdout}`);
    }
  }
}
async function waitFor(action, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function pair(password) {
  await cliRun('start');
  const code = await waitFor(async () => {
    try {
      const db = new DatabaseSync(path.join(scratch, 'data', 'relay.sqlite'), { readOnly: true });
      const row = db.prepare("SELECT user_code FROM device_codes WHERE approved = 0 AND denied = 0 ORDER BY created_at DESC LIMIT 1").get();
      db.close();
      return row?.user_code;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }, 'agent pairing code');
  const base = `http://127.0.0.1:${ports[1]}`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password, returnTo: '/' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie || login.status !== 302) throw new Error(`Isolated administrator login failed: HTTP ${login.status}`);
  const approval = await fetch(`${base}/device/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user_code: code, decision: 'allow' }) });
  if (approval.status !== 200) throw new Error(`Isolated pairing approval failed: HTTP ${approval.status}`);
  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    return response.ok && (await response.json()).devices === 1;
  }, 'paired agent connection');
  await assertState('running');
  await cliRun('stop');
  await assertState('stopped');
}
try {
  if (!reuse) {
    const official = await realpath(argument);
    const versionOutput = await run(official, ['version'], env);
    const version = versionOutput.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
    if (!version) throw new Error('Cannot determine Traefik version.');
    const [major, minor] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 7)) throw new Error('Traefik v3.7 or later is required.');
    const versionDir = path.join(scratch, 'traefik', 'versions', version);
    await mkdir(versionDir, { recursive: true });
    await copyFile(official, path.join(versionDir, 'traefik.exe'));
    await writeFile(path.join(scratch, 'traefik', 'versions.json'), JSON.stringify({ version: 1, current: version, previous: null }));
    await mkdir(path.join(scratch, 'data'), { recursive: true });
    await writeFile(path.join(scratch, 'data', 'relay.sqlite.setup-pending'), '', { flag: 'wx' });
    const password = randomBytes(24).toString('hex');
    await run(process.execPath, [cli, 'setup'], { ...env, BRC_ADMIN_USER: 'admin', BRC_ADMIN_PASSWORD: password });
    await pair(password);
    metadata = { version: 1, ports, traefikVersion: version };
    await writeFile(path.join(scratch, 'benchmark-fixture.json'), JSON.stringify(metadata), { flag: 'wx' });
  }
  report.traefikVersion = metadata.traefikVersion;
  await assertState('stopped');
  if (!diagnosticsOnly) {
    const samples = { coldStart: [], repeatedStart: [], status: [], help: [], stop: [] };
    for (let i = 0; i < 5; i++) {
      await assertState('stopped');
      for (const [label, command] of [['coldStart', 'start'], ['repeatedStart', 'start'], ['status', 'status'], ['help', 'help'], ['stop', 'stop']]) {
        const result = await cliRun(command);
        samples[label].push(result.ms);
        report.samples[label] = samples[label];
        await writeFile(reportFile, JSON.stringify(report, null, 2));
        if (label === 'coldStart' || label === 'repeatedStart') await assertState('running');
        if (label === 'stop') await assertState('stopped');
      }
    }
    report.results = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, summarize(values)]));
  }
  // Record nested method timings separately so instrumentation does not alter samples.
  await cliRun('start', true);
  await assertState('running');
  await cliRun('start', true);
  await cliRun('status', true);
  await cliRun('help', true);
  await cliRun('stop', true);
  await assertState('stopped');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  if (!diagnosticsOnly) console.log(JSON.stringify(report.results, null, 2));
  console.log(`Results: ${reportFile}`);
  console.log(`Phase timings: ${phaseFile}`);
} catch (error) {
  console.error(`Benchmark failed. No automatic stop or deletion was attempted. Inspect ${scratch}.`);
  throw error;
}
