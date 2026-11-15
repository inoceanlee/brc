import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = await mkdtemp(path.join(os.tmpdir(), 'brc-package-verification-'));
const output = path.join(workspace, 'packed');

async function runStage(name, argumentsList, env) {
  const started = performance.now();
  console.log(name);
  const child = spawn(process.execPath, argumentsList, {
    cwd: root, env, windowsHide: true, stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  console.log(name + ': ' + ((performance.now() - started) / 1000).toFixed(1) + 's');
  if (exitCode !== 0) throw new Error(name + ' failed with exit code ' + exitCode);
}
try {
  if (process.platform === 'win32' && !process.env.BRC_TRAEFIK_TEST_BINARY) {
    throw new Error('Set BRC_TRAEFIK_TEST_BINARY to the official Traefik executable before package verification.');
  }
  let tarball = process.env.BRC_PACKAGE_TARBALL;
  let updated = process.env.BRC_PACKAGE_UPDATED_TARBALL;
  if (!tarball) {
    await runStage('Build release and upgrade archives', [
      path.join(root, 'scripts', 'script-diagnostics.mjs'), path.join(root, 'scripts', 'pack-brc.mjs'), output, '--with-next-patch',
    ], process.env);
    const manifest = JSON.parse(await readFile(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));
    const [major, minor, patch] = manifest.version.split('.').map(Number);
    tarball = path.join(output, 'inoceanlee-brc-' + manifest.version + '.tgz');
    updated = path.join(output, 'next-patch', 'inoceanlee-brc-' + major + '.' + minor + '.' + (patch + 1) + '.tgz');
  }
  if (!updated) throw new Error('BRC_PACKAGE_UPDATED_TARBALL is required when verifying a prebuilt package.');
  await Promise.all([stat(tarball), stat(updated)]);
  await runStage('Verify package contents, install, update and uninstall', [
    '--test', path.join(root, 'tests', 'brc-package.test.mjs'),
  ], { ...process.env, BRC_PACKAGE_TARBALL: tarball, BRC_PACKAGE_UPDATED_TARBALL: updated });
} finally {
  await rm(workspace, { recursive: true, force: true });
}
