import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const WAIT_MS = 3_000;
const POLL_MS = 20;
const UNOWNED_GRACE_MS = 5_000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH';
  }
}

async function recoverAbandoned(filename: string): Promise<void> {
  let text: string;
  let metadata;
  try {
    [text, metadata] = await Promise.all([readFile(filename, 'utf8'), stat(filename)]);
  } catch { return; }
  if (Date.now() - metadata.mtimeMs < UNOWNED_GRACE_MS) return;
  let owner: { pid: number; token: string };
  try { owner = JSON.parse(text); } catch { return; }
  if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) return;
  const quarantine = filename + '.abandoned-' + randomUUID();
  try { await rename(filename, quarantine); }
  catch { return; }
  const moved = await stat(quarantine);
  const contents = await readFile(quarantine, 'utf8');
  if (moved.dev !== metadata.dev || moved.ino !== metadata.ino || contents !== text) {
    throw new Error('Diagnostic lock changed during recovery.');
  }
  await unlink(quarantine);
}

export async function withDiagnosticLogLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lock = filename + '.lock';
  const started = Date.now();
  const token = randomUUID();
  while (true) {
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      await recoverAbandoned(lock);
      if (Date.now() - started >= WAIT_MS) throw new Error('Diagnostic log lock timed out.');
      await sleep(POLL_MS);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      return await operation();
    } finally {
      await handle.close();
      try {
        const contents = JSON.parse(await readFile(lock, 'utf8')) as { token?: string };
        if (contents.token === token) await unlink(lock);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
  }
}
