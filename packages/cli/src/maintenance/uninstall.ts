import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { BrcPaths } from '../config/paths.js';
import { removeBrcData, type CleanupReport } from '../adapters/storage/cleanup.js';
import { GlobalPackageRemoval, type GlobalPackageManager, BRC_PACKAGE_NAME as PACKAGE_NAME } from './global-package.js';

// Global shims preserve the launch path; pnpm can resolve imported modules into its content store.
const globalPackageRemoval = new GlobalPackageRemoval(process.argv[1] ?? fileURLToPath(import.meta.url));
const PACKAGE_MANAGER_ENV_PATHS = [
  'PNPM_HOME',
  'PNPM_CONFIG_GLOBAL_DIR',
  'PNPM_CONFIG_GLOBAL_BIN_DIR',
  'PNPM_CONFIG_STORE_DIR',
  'PNPM_CONFIG_CACHE_DIR',
  'PNPM_CONFIG_STATE_DIR',
  'NPM_CONFIG_PREFIX',
] as const;

export interface PackageRemovalResult {
  scheduled: boolean;
  reportPath?: string;
}

export interface UninstallOptions {
  yes: boolean;
  paths: BrcPaths;
  confirm: (root: string) => Promise<boolean>;
  stopServices: () => Promise<void>;
  clean: () => Promise<void>;
  preparePackageRemoval?: () => GlobalPackageManager;
  removePackage: (manager?: GlobalPackageManager) => Promise<PackageRemovalResult | void>;
  write: (message: string) => void;
}

function isSameOrAncestor(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return isSameOrAncestor(left, right) || isSameOrAncestor(right, left);
}

async function validatePrivateDataRoot(paths: BrcPaths): Promise<string> {
  if (!path.isAbsolute(paths.root)) throw new Error('Refusing uninstall: BRC data root must be absolute.');
  const root = path.resolve(paths.root);
  if (root === path.parse(root).root) throw new Error(`Refusing uninstall: filesystem root is not a BRC data root (${root}).`);

  for (const name of ['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'] as const) {
    if (path.resolve(paths[name]) !== path.join(root, name)) {
      throw new Error(`Refusing uninstall: ${name} path is outside the normalized BRC data root.`);
    }
  }

  const protectedContainers = [
    os.homedir(),
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.cwd(),
    path.dirname(process.execPath),
  ].filter((value): value is string => Boolean(value));
  for (const protectedPath of protectedContainers) {
    if (isSameOrAncestor(root, protectedPath)) {
      throw new Error(`Refusing uninstall: BRC data root contains protected path ${path.resolve(protectedPath)}.`);
    }
  }

  const protectedTrees = [
    ...PACKAGE_MANAGER_ENV_PATHS.map((name) => process.env[name]),
    path.join(os.homedir(), '.brc'),
    path.join(os.homedir(), '.brc-relay'),
  ].filter((value): value is string => Boolean(value));
  for (const protectedPath of protectedTrees) {
    if (overlaps(root, protectedPath)) {
      throw new Error(`Refusing uninstall: BRC data root overlaps protected path ${path.resolve(protectedPath)}.`);
    }
  }

  let current = path.parse(root).root;
  for (const segment of path.relative(current, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return root;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Refusing uninstall: BRC data root path is a link or is not a plain directory (${current}).`);
    }
  }
  return root;
}

function writeRemovalReport(report: CleanupReport, write: (message: string) => void): boolean {
  for (const failure of report.failures) write(`BRC uninstall could not remove ${failure.path}: ${failure.reason}`);
  for (const preserved of report.preserved) write(`BRC uninstall preserved ${preserved.path}: ${preserved.reason}`);
  return report.failures.length > 0 || report.preserved.length > 0;
}

export async function confirmBrcUninstall(root: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw Object.assign(new Error('Use brc uninstall --yes in a non-interactive session.'), { exitCode: 2 });
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Remove all BRC data under "${root}" and uninstall ${PACKAGE_NAME}? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function uninstallBrc(options: UninstallOptions): Promise<void> {
  const root = await validatePrivateDataRoot(options.paths);
  if (!options.yes && !await options.confirm(root)) {
    options.write('BRC uninstall cancelled.');
    return;
  }

  const manager = options.preparePackageRemoval?.();
  await options.stopServices();
  await options.clean();
  const report = await removeBrcData(options.paths);
  const hasResiduals = writeRemovalReport(report, options.write);
  const result = await options.removePackage(manager);
  const packageRemoval = result?.scheduled && result.reportPath
    ? `BRC package removal scheduled; completion report: ${result.reportPath}`
    : 'BRC package removed.';
  options.write(hasResiduals
    ? `${packageRemoval} Review the residual paths above.`
    : `BRC data removed. ${packageRemoval}`);
}

export function detectGlobalBrcPackageManager(): GlobalPackageManager {
  return globalPackageRemoval.detectManager();
}

export async function removeGlobalBrcPackage(manager?: GlobalPackageManager): Promise<PackageRemovalResult> {
  if (!manager) throw new Error('Global package manager was not identified.');
  if (process.platform !== 'win32') {
    globalPackageRemoval.remove(manager);
    return { scheduled: false };
  }

  const reportPath = path.join(os.tmpdir(), 'brc-uninstall-' + randomUUID() + '.json');
  await writeFile(reportPath, JSON.stringify({
    package: PACKAGE_NAME, manager, status: 'pending', scheduledAt: new Date().toISOString(),
  }));
  const workerPath = fileURLToPath(new URL('./uninstall-worker.js', import.meta.url));
  const worker = spawn(process.execPath, [workerPath, String(process.pid), reportPath, PACKAGE_NAME, manager], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    worker.once('spawn', resolve);
    worker.once('error', reject);
  });
  worker.unref();
  return { scheduled: true, reportPath };
}
