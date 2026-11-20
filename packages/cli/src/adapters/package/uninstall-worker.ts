import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalPackageRemoval, isGlobalPackageManager, BRC_PACKAGE_NAME as PACKAGE_NAME } from './global-package.js';
const SHIM_SETTLE_DELAY_MS = 750;
const PARENT_EXIT_TIMEOUT_MS = 30_000;

interface RemovalReport {
  package: string;
  status: 'pending' | 'completed' | 'failed';
  scheduledAt: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  output?: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForParentExit(pid: number): Promise<void> {
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH' || errorCode(error) === 'EINVAL') return;
      throw error;
    }
    await sleep(50);
  }
  throw new Error(`Parent process ${pid} did not exit before timeout.`);
}

async function updateReport(reportPath: string, update: Partial<RemovalReport>): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as RemovalReport;
  await writeFile(reportPath, JSON.stringify({ ...report, ...update }, null, 2));
}

async function main(): Promise<void> {
  const parentPid = Number(process.argv[2]);
  const reportPath = path.resolve(process.argv[3] ?? '');
  const packageName = process.argv[4];
  const manager = process.argv[5];
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || packageName !== PACKAGE_NAME || !isGlobalPackageManager(manager)
      || path.dirname(reportPath) !== path.resolve(os.tmpdir())
      || !path.basename(reportPath).startsWith('brc-uninstall-')) {
    throw new Error('Invalid uninstall worker arguments.');
  }

  try {
    await waitForParentExit(parentPid);
    await sleep(SHIM_SETTLE_DELAY_MS);
    const result = new GlobalPackageRemoval(fileURLToPath(import.meta.url)).remove(manager);
    await updateReport(reportPath, { status: 'completed', completedAt: new Date().toISOString(), exitCode: 0, output: result.output });
  } catch (error) {
    await updateReport(reportPath, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      exitCode: error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await main();
