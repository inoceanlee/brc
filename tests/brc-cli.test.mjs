import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SqliteStore } from '../packages/relay/dist/adapters/storage/sqlite.js';

const cliEntry = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const cliUrl = JSON.stringify(pathToFileURL(cliEntry).href);
const pathsEntry = fileURLToPath(new URL('../packages/cli/dist/config/paths.js', import.meta.url));
const pathsUrl = JSON.stringify(pathToFileURL(pathsEntry).href);

function runCliProcess(args, dataRoot = path.join(os.tmpdir(), 'brc-cli-process-test'), extraEnv = {}) {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  return spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...inheritedEnv, ...extraEnv, BRC_DATA_ROOT: dataRoot },
  });
}

async function makeCleanupFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-clean-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs, { recursive: true });
  const expiredLog = path.join(logs, 'expired.log');
  await writeFile(expiredLog, 'expired');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(expiredLog, old, old);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, expiredLog };
}

function runProbe(body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { runCli } from ${cliUrl};\nimport { resolveBrcPaths } from ${pathsUrl};\n${body}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function probeResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('no arguments show status summary and command help', () => {
  const result = runCliProcess([]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC unified CLI/);
  assert.match(result.stdout, /brc status/);
});

test('help explains package-only removal and full uninstall', () => {
  const result = runCliProcess(['help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm remove -g @inoceanlee\/brc/);
  assert.match(result.stdout, /brc uninstall/);
});

test('help and invalid arguments do not initialize configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-light-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'brc.yaml.last-good'), 'invalid: [');
  const help = runCliProcess(['help'], root);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /BRC unified CLI/);
  const invalid = runCliProcess(['start', 'extra'], root);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /does not accept extra arguments/);
  const invalidValue = runCliProcess(['config', 'set', 'proxy.rate.average', 'invalid'], root);
  assert.notEqual(invalidValue.status, 0);
  assert.match(invalidValue.stderr, /average|number/i);
});
test('non-interactive uninstall requires --yes and preserves private data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-uninstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'data', 'private.sqlite');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, 'isolated database');

  const result = runCliProcess(['uninstall'], root);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--yes/);
  assert.equal(await readFile(marker, 'utf8'), 'isolated database');
});

test('CLI entrypoint runs through a directory junction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = path.join(root, 'alias');
  await symlink(path.dirname(cliEntry), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  const result = spawnSync(process.execPath, [path.join(alias, path.basename(cliEntry)), 'help'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...inheritedEnv, BRC_DATA_ROOT: path.join(root, 'data') },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC unified CLI/);
});

test('unknown commands return usage error', () => {
  const result = runCliProcess(['unknown']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unknown command/);
});

test('invalid command arguments do not invoke command handlers', () => {
  const result = probeResult(runProbe(`
const calls = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => { calls.push(name); return 0; }]));
const exitCode = await runCli(['update', 'relay'], { paths, commands, clean: async () => {}, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, calls }));
`));

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.calls, []);
});
test('uninstall accepts --yes and owns its stop-clean-remove ordering', () => {
  const result = probeResult(runProbe(`
const calls = [];
let cleanCount = 0;
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = {
  uninstall: async ({ yes }, clean) => {
    calls.push(['uninstall', yes]);
    await clean();
    calls.push('remove package');
    return 0;
  },
};
const exitCode = await runCli(['uninstall', '--yes'], { paths, commands, clean: async () => { cleanCount++; calls.push('clean'); }, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, cleanCount, calls }));
`));

  assert.deepEqual(result, {
    exitCode: 0,
    cleanCount: 1,
    calls: [['uninstall', true], 'clean', 'remove package'],
  });
});

test('failed uninstall does not run automatic cleanup out of order', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const errors = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = { uninstall: async () => { throw new Error('service stop failed'); } };
const exitCode = await runCli(['uninstall', '--yes'], { paths, commands, clean: async () => { cleanCount++; }, write: () => {}, writeError: (message) => errors.push(message) });
console.log(JSON.stringify({ exitCode, cleanCount, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanCount, 0);
  assert.match(result.errors.join('\\n'), /service stop failed/);
});

test('command exit code survives one cleanup failure', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const calls = [];
const errors = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => { calls.push(name); return name === 'start' ? 37 : 0; }]));
const exitCode = await runCli(['start'], { paths, commands, clean: async () => { cleanCount += 1; throw new Error('cleanup failed'); }, write: () => {}, writeError: (message) => errors.push(message) });
console.log(JSON.stringify({ exitCode, cleanCount, calls, errors }));
`));

  assert.equal(result.exitCode, 37);
  assert.equal(result.cleanCount, 1);
  assert.deepEqual(result.calls, ['start']);
  assert.match(result.errors.join('\n'), /cleanup failed/);
});

test('status reports degraded exit code for every output format', () => {
  const result = probeResult(runProbe(`
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const services = [{ name: 'relay', state: 'degraded', pid: null, detail: 'unhealthy' }];
const results = [];
for (const format of ['table', 'plain', 'json', 'yaml']) {
  const output = [];
  const exitCode = await runCli(['status', '--output', format], {
    paths, commands: { status: async () => 1 }, statusJson: async () => ({ services }),
    clean: async () => {}, write: (value) => output.push(value), writeError: () => {},
  });
  results.push({ format, exitCode, output });
}
console.log(JSON.stringify(results));
`));
  for (const item of result) {
    assert.equal(item.exitCode, 1, item.format);
    if (item.format === 'json') assert.equal(JSON.parse(item.output[0]).services[0].state, 'degraded');
  }
});

test('JSON command errors remain parseable when automatic cleanup also fails', () => {
  const result = probeResult(runProbe(`
const errors = [];
const output = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const exitCode = await runCli(['start', '--json'], {
  paths, commands: { start: async () => { throw new Error('start failed'); } },
  clean: async () => { throw new Error('cleanup failed'); },
  write: (message) => output.push(message), writeError: (message) => errors.push(message),
});
console.log(JSON.stringify({ exitCode, output, errors }));
`));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.output, []);
  assert.equal(result.errors.length, 1);
  const failure = JSON.parse(result.errors[0]);
  assert.equal(failure.message, 'start failed');
  assert.equal(failure.exit_code, 1);
  assert.match(failure.cleanup.message, /cleanup failed/);
});

test('JSON output stays clean when automatic cleanup fails after success or invalid input', () => {
  const results = probeResult(runProbe(`
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const results = [];
for (const args of [['version', '--json'], ['--json', '--not-real']]) {
  const output = [];
  const errors = [];
  const exitCode = await runCli(args, {
    paths, commands: {}, clean: async () => { throw new Error('cleanup failed'); },
    write: (message) => output.push(message), writeError: (message) => errors.push(message),
  });
  results.push({ exitCode, output, errors });
}
console.log(JSON.stringify(results));
`));
  assert.equal(results[0].exitCode, 0);
  assert.equal(typeof JSON.parse(results[0].output[0]).version, 'string');
  const warning = JSON.parse(results[0].errors.join('\n'));
  assert.equal(warning.code, 'CLEANUP_FAILED');
  assert.equal(warning.command_exit_code, 0);
  assert.match(warning.message, /cleanup failed/);
  assert.equal(results[1].exitCode, 2);
  assert.deepEqual(results[1].output, []);
  const usage = JSON.parse(results[1].errors.join('\n'));
  assert.equal(usage.exit_code, 2);
  assert.match(usage.cleanup.message, /cleanup failed/);
});

test('successful JSON mutations retain success when automatic cleanup fails', () => {
  const result = probeResult(runProbe(`
const output = [];
const errors = [];
let mutations = 0;
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const exitCode = await runCli(['start', '--json'], {
  paths, commands: { start: async () => { mutations++; return 0; } },
  clean: async () => { throw new Error('cleanup failed'); },
  write: (message) => output.push(message), writeError: (message) => errors.push(message),
});
console.log(JSON.stringify({ exitCode, output, errors, mutations }));
`));
  assert.equal(result.exitCode, 0);
  assert.equal(result.mutations, 1);
  assert.equal(JSON.parse(result.output[0]).status, 'success');
  const warning = JSON.parse(result.errors.join('\n'));
  assert.equal(warning.code, 'CLEANUP_FAILED');
  assert.equal(warning.command_exit_code, 0);
});

test('structured command failures retain their details and exit code when cleanup fails', () => {
  const result = probeResult(runProbe(`
const errors = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const exitCode = await runCli(['start', '--json'], {
  paths, commands: { start: async () => ({
    status: 'error', error: { code: 'CONFLICT', exitCode: 5, message: 'busy', run: 'brc status', retryable: false, details: { service: 'relay' } },
  }) },
  clean: async () => { throw new Error('cleanup failed'); },
  write: () => {}, writeError: (message) => errors.push(message),
});
console.log(JSON.stringify({ exitCode, errors }));
`));
  assert.equal(result.exitCode, 5);
  const failure = JSON.parse(result.errors.join('\n'));
  assert.equal(failure.code, 'CONFLICT');
  assert.deepEqual(failure.details, { service: 'relay' });
  assert.match(failure.cleanup.message, /cleanup failed/);
});

test('JSON preserves trace and cleanup failures without replacing command results', () => {
  const results = probeResult(runProbe(`
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const trace = { span: async (_name, task) => task(), finish: () => ({ durationMs: 1, unaccountedMs: 0, stages: [] }) };
const results = [];
for (const outcome of ['success', 'failure', 'cancel']) {
  const output = [];
  const errors = [];
  const exitCode = await runCli(['start', '--json'], {
    paths, trace, timing: true,
    commands: { start: async () => {
      if (outcome === 'failure') throw Object.assign(new Error('service busy'), { exitCode: 5 });
      if (outcome === 'cancel') throw Object.assign(new Error('interrupted'), { exitCode: 130 });
      return 0;
    } },
    clean: async () => { throw new Error('cleanup failed'); },
    onTrace: async () => { throw new Error('trace storage failed'); },
    write: (message) => output.push(message), writeError: (message) => errors.push(message),
  });
  results.push({ exitCode, output, errors });
}
console.log(JSON.stringify(results));
`));
  for (const [index, exitCode] of [0, 5, 130].entries()) {
    const result = results[index];
    assert.equal(result.exitCode, exitCode);
    const diagnostic = JSON.parse(result.errors.join('\n'));
    assert.match(diagnostic.cleanup.message, /cleanup failed/);
    assert.match(diagnostic.trace.message, /trace storage failed/);
    assert.ok(diagnostic.diagnostics.some((line) => line.includes('Startup total')));
    if (exitCode === 5) {
      assert.equal(diagnostic.code, 'CONFLICT');
      assert.equal(diagnostic.message, 'service busy');
    } else {
      assert.equal(diagnostic.command_exit_code, exitCode);
    }
  }
  assert.equal(JSON.parse(results[0].output[0]).status, 'success');
  assert.deepEqual(results[1].output, []);
  assert.deepEqual(results[2].output, []);
});

test('JSON reports a trace write failure even when automatic cleanup succeeds', () => {
  const result = probeResult(runProbe(`
const errors = [];
const output = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const trace = { span: async (_name, task) => task(), finish: () => ({ durationMs: 1, unaccountedMs: 0, stages: [] }) };
const exitCode = await runCli(['start', '--json'], {
  paths, trace, commands: { start: async () => 0 }, clean: async () => {},
  onTrace: async () => { throw new Error('trace storage failed'); },
  write: (message) => output.push(message), writeError: (message) => errors.push(message),
});
console.log(JSON.stringify({ exitCode, output, errors }));
`));
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.output[0]).status, 'success');
  const warning = JSON.parse(result.errors.join('\n'));
  assert.equal(warning.code, 'TRACE_WRITE_FAILED');
  assert.equal(warning.command_exit_code, 0);
  assert.match(warning.trace.message, /trace storage failed/);
});

test('automatic cleanup reports do not corrupt JSON usage errors', async (t) => {
  const { root, expiredLog } = await makeCleanupFixture(t);
  const result = runCliProcess(['--json', '--not-real'], root);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).exit_code, 2);
  assert.equal(existsSync(expiredLog), false);
});

test('clean command runs cleanup once without recursion', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => 0]));
const exitCode = await runCli(['clean'], { paths, commands, clean: async () => { cleanCount += 1; }, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, cleanCount }));
`));

  assert.deepEqual(result, { exitCode: 0, cleanCount: 1 });
});

test('brc clean removes expired files and reports the cleanup result', async (t) => {
  const fixture = await makeCleanupFixture(t);
  const result = runCliProcess(['clean'], fixture.root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.expiredLog), false);
  assert.match(result.stderr, /BRC cleanup: removed 1 items/);
  assert.doesNotMatch(result.stdout, /BRC cleanup:/);
});

test('automatic cleanup runs after help, invalid commands, and startup failure', async (t) => {
  for (const args of [['help'], ['unknown']]) {
    const fixture = await makeCleanupFixture(t);
    const result = runCliProcess(args, fixture.root);
    assert.equal(result.status, args[0] === 'help' ? 0 : 2, result.stderr);
    assert.equal(existsSync(fixture.expiredLog), false);
  }

  const fixture = await makeCleanupFixture(t);
  SqliteStore.initialize(path.join(fixture.root, 'data', 'relay.sqlite'));
  const result = runCliProcess(['start'], fixture.root, { BRC_ADMIN_PASSWORD: '', BRC_RELAY_PORT: '13000' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.expiredLog), false);
  const relayLog = await readFile(path.join(fixture.root, 'logs', 'relay.log'), 'utf8');
  assert.match(relayLog, /Relay administrator identity is missing or ambiguous/);
});
test('noninteractive first setup fails before creating a new identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-first-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = runCliProcess(['setup'], root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /interactive terminal.*administrator password/i);
  assert.equal(existsSync(path.join(root, 'data', 'relay.sqlite')), false);
});

test('public URL persists through separate CLI invocations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-public-url-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = 'https://brc.example.com';
  const saved = runCliProcess(['config', 'set', 'services.publicUrl', origin], root);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /restartRequired: true/);
  const loaded = runCliProcess(['config', 'get', 'services.publicUrl'], root);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /key: services\.publicUrl/);
  assert.match(loaded.stdout, /value: https:\/\/brc\.example\.com/);
  assert.match(loaded.stdout, /source: file/);
});

test('data-root override resolves isolated paths without using Agent BRC_HOME', () => {
  const override = path.join(os.tmpdir(), 'isolated-brc');
  const result = probeResult(runProbe(`
const paths = resolveBrcPaths({ BRC_DATA_ROOT: ${JSON.stringify(override)}, BRC_HOME: 'agent-credentials' });
console.log(JSON.stringify(paths));
`));
  const root = path.resolve(override);

  assert.deepEqual(result, {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    diagnostics: path.join(root, 'diagnostics'),
    tmp: path.join(root, 'tmp'),
  });
  for (const value of Object.values(result)) assert.equal(path.isAbsolute(value), true);
});

test('config set persists validated settings in the selected data root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runCliProcess(['config', 'set', 'proxy.rate.average', '20'], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /key: proxy\.rate\.average/);
  assert.match(result.stdout, /value: 20/);
  const config = await readFile(path.join(root, 'config', 'brc.yaml'), 'utf8');
  assert.match(config, /average: 20/);
});
test('interactive first setup asks for password and confirmation before accepting credentials', async () => {
  const { collectAdministratorCredentials } = await import('../packages/cli/dist/commands/setup.js');
  const prompts = [];
  const answers = ['example-password', 'example-password'];
  const credentials = await collectAdministratorCredentials({ BRC_ADMIN_USER: 'operator' }, true, {
    askUsername: async () => { throw new Error('username must come from environment'); },
    askHiddenPassword: async (label) => { prompts.push(label); return answers.shift(); },
  });
  assert.deepEqual(credentials, { username: 'operator', password: 'example-password' });
  assert.deepEqual(prompts, ['Administrator password (hidden): ', 'Confirm administrator password (hidden): ']);
});

test('interactive first setup rejects mismatched passwords before creating an identity', async () => {
  const { collectAdministratorCredentials } = await import('../packages/cli/dist/commands/setup.js');
  const prompts = [];
  const answers = ['example-password', 'different-password'];
  await assert.rejects(collectAdministratorCredentials({}, true, {
    askUsername: async () => 'admin',
    askHiddenPassword: async (label) => { prompts.push(label); return answers.shift(); },
  }), /passwords do not match/i);
  assert.equal(prompts.length, 2);
});

test('explicit environment password keeps noninteractive setup compatible', async () => {
  const { collectAdministratorCredentials } = await import('../packages/cli/dist/commands/setup.js');
  const credentials = await collectAdministratorCredentials({ BRC_ADMIN_USER: 'ci', BRC_ADMIN_PASSWORD: 'example-password' }, false, {
    askUsername: async () => { throw new Error('must not prompt'); },
    askHiddenPassword: async () => { throw new Error('must not prompt'); },
  });
  assert.deepEqual(credentials, { username: 'ci', password: 'example-password' });
});

test('first setup without a terminal or supplied password refuses to initialize', async () => {
  const { collectAdministratorCredentials } = await import('../packages/cli/dist/commands/setup.js');
  await assert.rejects(collectAdministratorCredentials({}, false, {
    askUsername: async () => { throw new Error('must not prompt'); },
    askHiddenPassword: async () => { throw new Error('must not prompt'); },
  }), /interactive terminal.*administrator password/i);
});

test('Traefik progress renders real byte percentages and stops on completion', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 50, totalBytes: 100 });
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 20, totalBytes: 100 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  progress.report({ operation: 'setup', stage: 'download', status: 'completed', completedBytes: 100, totalBytes: 100 });
  const text = output.text;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(output.text, text);
  assert.match(text, /50%/);
  assert.doesNotMatch(text, /20%/);
});

test('non-TTY progress reports stages once without ANSI or percentages', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: false, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'update', stage: 'download', status: 'started' });
  progress.report({ operation: 'update', stage: 'download', status: 'started', completedBytes: 1 });
  progress.report({ operation: 'update', stage: 'download', status: 'completed' });
  assert.equal(output.text.split('\n').filter(Boolean).length, 1);
  assert.doesNotMatch(output.text, /\x1b|%|\r/);
});

test('failed progress stops animation', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'health', status: 'started' });
  progress.report({ operation: 'setup', stage: 'health', status: 'failed' });
  const text = output.text;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(output.text, text);
});

test('interrupt cleanup stops an active progress animation', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  progress.stop();
  const text = output.text;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(output.text, text);
});

test('byte updates do not redraw until the animation timer fires', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  const initial = output.text;
  for (let i = 1; i < 1000; i++) {
    progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: i, totalBytes: 1000 });
  }
  assert.equal(output.text, initial);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.match(output.text, /99%/);
  progress.stop();
});

test('SIGINT clears a live progress line and preserves interrupt exit semantics', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const progressUrl = JSON.stringify(new URL('../packages/cli/dist/progress.js', import.meta.url).href);
  const source = `import { TraefikProgress, installProgressInterruptHandler } from ${progressUrl};
    const output = { isTTY: true, write: (text, callback) => process.stdout.write(text, callback) };
    const progress = new TraefikProgress(output);
    installProgressInterruptHandler(progress);
    progress.report({ operation: 'setup', stage: 'download', status: 'started' });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('READY\n') && !child.killed) child.kill('SIGINT');
  });
  const result = await ended;
  assert.ok(result.signal === 'SIGINT' || (process.platform === 'win32' && result.code !== 0), stderr);
  assert.match(stdout, /READY\n[\s\S]*\r\x1b\[2K/);
});

test('asynchronous progress stream errors do not change command outcome', async () => {
  const progressUrl = JSON.stringify(new URL('../packages/cli/dist/progress.js', import.meta.url).href);
  const source = `import { Writable } from 'node:stream';
    import { TraefikProgress } from ${progressUrl};
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('closed'), { code: 'EPIPE' })); } });
    output.isTTY = true;
    const progress = new TraefikProgress(output);
    progress.report({ operation: 'setup', stage: 'download', status: 'started' });
    setTimeout(() => { progress.stop(); process.exitCode = 7; }, 30);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 7, result.stderr);
});

test('backpressure flushes the final clear after drain', async () => {
  const { EventEmitter } = await import('node:events');
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  class Output extends EventEmitter {
    isTTY = true;
    text = '';
    write(text, callback) {
      this.text += text;
      callback?.();
      return this.text.length > text.length;
    }
  }
  const output = new Output();
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  const stopping = progress.stopAndWait();
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 80, totalBytes: 100 });
  progress.report({ operation: 'setup', stage: 'health', status: 'started' });
  output.emit('drain');
  await stopping;
  assert.ok(output.text.endsWith('\r\x1b[2K'));
  const text = output.text;
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 100, totalBytes: 100 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(output.text, text);
});

test('interrupt cleanup is bounded when a blocked stream never drains', async () => {
  const { EventEmitter } = await import('node:events');
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  class Output extends EventEmitter {
    isTTY = true;
    write(_text, callback) { callback?.(); return false; }
  }
  const progress = new TraefikProgress(new Output());
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  await Promise.race([
    progress.stopAndWait(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('interrupt cleanup timed out')), 1500)),
  ]);
});

test('backpressure retains the latest progress frame until drain', async () => {
  const { EventEmitter } = await import('node:events');
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  class Output extends EventEmitter {
    isTTY = true;
    text = '';
    write(text, callback) {
      const first = this.text.length === 0;
      this.text += text;
      callback?.();
      return !first;
    }
  }
  const output = new Output();
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  progress.report({ operation: 'setup', stage: 'download', status: 'started', completedBytes: 50, totalBytes: 100 });
  await new Promise((resolve) => setTimeout(resolve, 180));
  output.emit('drain');
  assert.match(output.text, /50%/);
  progress.stop();
});

test('non-TTY stages remain ordered across backpressure and drain', async () => {
  const { EventEmitter } = await import('node:events');
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  class Output extends EventEmitter {
    isTTY = false;
    text = '';
    write(text, callback) {
      const first = this.text.length === 0;
      this.text += text;
      queueMicrotask(() => callback?.());
      return !first;
    }
  }
  const output = new Output();
  const progress = new TraefikProgress(output);
  for (const stage of ['release', 'download', 'verify', 'stage', 'health']) {
    progress.report({ operation: 'setup', stage, status: 'started' });
    progress.report({ operation: 'setup', stage, status: 'completed' });
  }
  output.emit('drain');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output.text.trim().split('\n'), [
    'Traefik setup: release', 'Traefik setup: download', 'Traefik setup: verify',
    'Traefik setup: stage', 'Traefik setup: health',
  ]);
  assert.doesNotMatch(output.text, /\x1b|\r/);
});

test('non-TTY output error during backpressure permits interrupt cleanup', async () => {
  const { EventEmitter } = await import('node:events');
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  class Output extends EventEmitter {
    isTTY = false;
    write(_text, callback) { queueMicrotask(() => callback?.()); return false; }
  }
  const output = new Output();
  const progress = new TraefikProgress(output);
  progress.report({ operation: 'setup', stage: 'release', status: 'started' });
  progress.report({ operation: 'setup', stage: 'download', status: 'started' });
  const stopping = progress.stopAndWait();
  output.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
  await stopping;
});

test('no-color progress avoids ANSI and quiet progress emits nothing', async () => {
  const { TraefikProgress } = await import('../packages/cli/dist/progress.js');
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const plain = new TraefikProgress(output, { color: false });
  plain.report({ operation: 'setup', stage: 'download', status: 'started' });
  plain.stop();
  assert.doesNotMatch(output.text, /\x1b/);
  const quietOutput = { isTTY: true, text: '', write(value) { this.text += value; } };
  const quiet = new TraefikProgress(quietOutput, { enabled: false });
  quiet.report({ operation: 'update', stage: 'download', status: 'started' });
  quiet.stop();
  assert.equal(quietOutput.text, '');
});

test('command timeout aborts the active operation, reports JSON error, and still cleans', () => {
  const result = runProbe(`
const paths = resolveBrcPaths({ BRC_DATA_ROOT: process.env.TEMP + '/brc-cli-timeout-probe' });
const errors = [];
let aborted = false;
let cleaned = false;
const deps = {
  paths,
  commands: {
    setup: async () => 0,
    start: async (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      if (signal.aborted) { aborted = true; reject(signal.reason); }
    }),
    stop: async () => 0,
    restart: async () => 0,
    status: async () => 0,
    logs: async () => 0,
    config: async () => 0,
    updateTraefik: async () => 0,
    uninstall: async () => 0,
  },
  clean: async () => { cleaned = true; },
  write: () => {},
  writeError: (message) => errors.push(message),
};
const exitCode = await runCli(['start', '--timeout=25ms', '--json'], deps);
console.log(JSON.stringify({ exitCode, aborted, cleaned, error: errors[0] }));
`);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.exitCode, 1);
  assert.equal(value.aborted, true);
  assert.equal(value.cleaned, true);
  const error = JSON.parse(value.error);
  assert.equal(error.exit_code, 1);
  assert.match(error.message, /timed out after 25 ms/i);
});

test('restart timeout reaches the locked stop before starting services', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-restart-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowUrl = new URL('../packages/cli/dist/core/lifecycle/workflow.js', import.meta.url).href;
  const databaseUrl = new URL('../packages/cli/dist/adapters/storage/relay-database.js', import.meta.url).href;
  const probe = `
const { ServiceManager } = await import(${JSON.stringify(workflowUrl)});
const { RelayDatabase } = await import(${JSON.stringify(databaseUrl)});
RelayDatabase.prototype.assertExists = () => {};
ServiceManager.prototype.withLock = async function (operation) {
  return operation({
    stop: async (signal) => {
      if (!signal) throw new Error('stop did not receive cancellation');
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    start: async () => { throw new Error('restart started after cancellation'); },
  });
};
process.argv = [process.execPath, ${JSON.stringify(cliEntry)}, 'restart', '--timeout=25ms', '--json'];
await import(${cliUrl});
`;
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...inheritedEnv, BRC_DATA_ROOT: root, DO_NOT_TRACK: '1' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.match(error.message, /timed out/i);
  assert.doesNotMatch(error.message, /did not receive cancellation|started after cancellation/);
});
