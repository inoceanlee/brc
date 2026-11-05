import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ProcessIdentity {
  pid: number;
  createdAt: string;
  executablePath: string;
  commandLine: string;
}

const run = promisify(execFile);
const nativeBinary = fileURLToPath(new URL('../native/win32-x64/brc-process.exe', import.meta.url));

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function exitStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
function parseProcessIdentity(value: unknown): ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('pid' in value) || !('createdAt' in value) || !('executablePath' in value) || !('commandLine' in value)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !/^\d+$/.test(value.createdAt)
      || typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath)
      || typeof value.commandLine !== 'string' || !value.commandLine) {
    throw new Error('Windows returned incomplete process identity.');
  }
  return { pid: value.pid, createdAt: value.createdAt, executablePath: value.executablePath, commandLine: value.commandLine };
}

async function inspectWindows(pids: readonly number[]): Promise<Map<number, ProcessIdentity | null>> {
  let stdout: string;
  try {
    ({ stdout } = await run(nativeBinary, ['inspect', ...pids.map(String)], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: false,
      maxBuffer: Math.min(pids.length * 64 * 1024, 64 * 1024 * 1024),
    }));
  } catch (error) {
    throw new Error(`Native Windows process inspection failed: ${errorCode(error) ?? 'UNKNOWN'}.`, { cause: error });
  }
  let data: unknown;
  try { data = JSON.parse(stdout) as unknown; }
  catch { throw new Error('Native Windows process inspection returned malformed JSON.'); }
  if (!data || typeof data !== 'object' || !('processes' in data) || !Array.isArray(data.processes)
      || data.processes.length !== pids.length) throw new Error('Native Windows process inspection returned incomplete results.');
  const result = new Map<number, ProcessIdentity | null>();
  for (const entry of data.processes as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('pid' in entry)
        || !Number.isSafeInteger(entry.pid) || !pids.includes(entry.pid as number) || result.has(entry.pid as number)
        || !('status' in entry)) throw new Error('Native Windows process inspection returned unexpected results.');
    const pid = entry.pid as number;
    if (entry.status === 'not_found') result.set(pid, null);
    else if (entry.status === 'found') result.set(pid, parseProcessIdentity(entry));
    else if (entry.status === 'error') {
      const code = 'code' in entry && typeof entry.code === 'string' && /^[A-Z_]+$/.test(entry.code) ? entry.code : 'UNKNOWN';
      // Windows System (PID 4) can allow opening its handle but deny image-path lookup.
      if (code === 'OPEN_PROCESS' || (pid === 4 && code === 'PROCESS_PATH')) result.set(pid, null);
      else throw new Error(`Native Windows process inspection could not verify PID ${pid}: ${code}.`);
    } else throw new Error('Native Windows process inspection returned an invalid status.');
  }
  return result;
}

export async function inspectProcesses(pids: readonly number[]): Promise<Map<number, ProcessIdentity | null>> {
  for (const pid of pids) if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error(`Invalid process ID: ${pid}`);
  const unique = [...new Set(pids)];
  if (!unique.length) return new Map();
  if (process.platform === 'win32') return inspectWindows(unique);
  const result = new Map<number, ProcessIdentity | null>();
  await Promise.all(unique.map(async (pid) => { result.set(pid, await inspectNonWindows(pid)); }));
  return result;
}
export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  return (await inspectProcesses([pid])).get(pid) ?? null;
}

async function inspectNonWindows(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === 'linux') {
    let stat: string;
    let executablePath: string;
    let rawCommand: Buffer;
    try {
      [stat, executablePath, rawCommand] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'), realpath(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`),
      ]);
    } catch (error) {
      const err = errorCode(error);
      if (err === 'ENOENT' || err === 'EACCES' || err === 'EPERM') return null;
      throw error;
    }
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) throw new Error(`Linux returned malformed process identity for ${pid}.`);
    const startTicks = stat.slice(closeParen + 2).trim().split(/\s+/)[19];
    if (!startTicks) throw new Error(`Linux returned incomplete start time for process ${pid}.`);
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const commandLine = rawCommand.toString('utf8').split('\0').filter(Boolean).join(' ');
    if (!commandLine) return null;
    return { pid, createdAt: `${bootId}:${startTicks}`, executablePath, commandLine };
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout: createdAt } = await run('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', windowsHide: true });
      const { stdout: executablePath } = await run('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true });
      const { stdout: commandLine } = await run('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', windowsHide: true });
      if (!createdAt.trim() || !executablePath.trim() || !commandLine.trim()) return null;
      return { pid, createdAt: createdAt.trim(), executablePath: executablePath.trim(), commandLine: commandLine.trim() };
    } catch (error) {
      if (exitStatus(error) === 1) return null;
      throw error;
    }
  }
  throw new Error(`Managed process inspection is unsupported on ${process.platform}.`);
}
