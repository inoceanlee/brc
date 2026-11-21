import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repoRoot, 'packages', 'agent', 'dist', 'cli.js');
const cliUrl = pathToFileURL(cli).href;

function childEnv(dataRoot, home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRC_')));
  env.BRC_DATA_ROOT = dataRoot;
  env.DO_NOT_TRACK = '1';
  env.CI = 'true';
  if (home) {
    env.USERPROFILE = home;
    env.HOME = home;
  }
  return env;
}

test('core preview file typing uses pure string logic without Node path import', async () => {
  const { resolvePreviewFileType } = await import(pathToFileURL(path.join(repoRoot, 'packages', 'agent', 'dist', 'core', 'ui', 'file-preview', 'shared', 'preview-file-types.js')).href);
  assert.equal(resolvePreviewFileType('D:\\docs\\README.MD'), 'markdown');
  assert.equal(resolvePreviewFileType('/a/b/.env'), 'text');
  assert.equal(resolvePreviewFileType('/a/b/.gitignore'), 'text');
  assert.equal(resolvePreviewFileType('/a/b/notes.markdown'), 'markdown');
  assert.equal(resolvePreviewFileType('/a/b/page.HTML'), 'html');
  assert.equal(resolvePreviewFileType('/a/b/data.bin'), 'unsupported');
});

test('Agent core files contain no Node builtin imports', () => {
  const core = path.join(repoRoot, 'packages', 'agent', 'src', 'core');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : entry.name.endsWith('.ts') ? [target] : [];
  });
  for (const file of walk(core)) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"]node:/, file);
    assert.doesNotMatch(source, /from\s+['"](?:fs|path|http|https|os|child_process|url)['"]/, file);
  }
});

test('credential migration runs for a custom data root and always offers the legacy path', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'brc-t10-home-'));
  const root = mkdtempSync(path.join(tmpdir(), 'brc-t10-cred-'));
  try {
    const legacyDir = path.join(home, '.brc');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = { relayUrl: 'https://relay.example', deviceId: 'legacy-device', deviceToken: 'legacy-token', name: 'legacy', pairedAt: '2026-01-01' };
    writeFileSync(path.join(legacyDir, 'device.json'), JSON.stringify(legacy));
    const script = `
      const { createAgentCredentials } = await import(${JSON.stringify(cliUrl)});
      process.stdout.write(JSON.stringify(createAgentCredentials(process.env).load()));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv(root, home), encoding: 'utf8', timeout: 8000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).deviceId, 'legacy-device');
    assert.equal(existsSync(path.join(legacyDir, 'device.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy config migration runs for custom data root and keeps a backup before removal', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'brc-t10-home-'));
  const root = mkdtempSync(path.join(tmpdir(), 'brc-t10-config-'));
  try {
    const legacyDir = path.join(home, '.brc');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = { version: 1, fileReadLineLimit: 777, defaultShell: '/bin/zsh' };
    const legacyFile = path.join(legacyDir, 'config.json');
    writeFileSync(legacyFile, JSON.stringify(legacy));
    const script = `
      const { configureAgentServices } = await import(${JSON.stringify(cliUrl)});
      const services = await configureAgentServices();
      process.stdout.write(String(await services.configManager.getValue('fileReadLineLimit')));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv(root, home), encoding: 'utf8', timeout: 8000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '777');
    assert.equal(existsSync(legacyFile), false);
    assert.equal(existsSync(legacyFile + '.bak'), true);
    assert.equal(JSON.parse(readFileSync(legacyFile + '.bak', 'utf8')).fileReadLineLimit, 777);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic exit codes map permission, not-found, conflict, usage and runtime errors', async () => {
  const { classifyAgentError } = await import(pathToFileURL(path.join(repoRoot, 'packages', 'agent', 'dist', 'commands', 'errors.js')).href);
  const { AgentUsageError } = await import(pathToFileURL(path.join(repoRoot, 'packages', 'agent', 'dist', 'commands', 'parser.js')).href);
  assert.equal(classifyAgentError(Object.assign(new Error('denied'), { code: 'EACCES' })).exitCode, 3);
  assert.equal(classifyAgentError(Object.assign(new Error('denied'), { code: 'EPERM' })).code, 'PERMISSION_DENIED');
  assert.equal(classifyAgentError(Object.assign(new Error('missing'), { code: 'ENOENT' })).exitCode, 4);
  assert.equal(classifyAgentError(Object.assign(new Error('missing'), { code: 'ENOENT' })).code, 'NOT_FOUND');
  assert.equal(classifyAgentError(Object.assign(new Error('busy'), { exitCode: 5 })).exitCode, 5);
  assert.equal(classifyAgentError(Object.assign(new Error('exists'), { code: 'EEXIST' })).code, 'CONFLICT');
  assert.equal(classifyAgentError(new AgentUsageError('bad flag')).exitCode, 2);
  assert.equal(classifyAgentError(new Error('unknown')).exitCode, 1);
});
