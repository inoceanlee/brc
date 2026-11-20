import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRC_PACKAGE_NAME = '@inoceanlee/brc';
export type GlobalPackageManager = 'pnpm' | 'npm';
const SUPPORTED_MANAGERS: readonly GlobalPackageManager[] = ['pnpm', 'npm'];

interface CommandOutput {
  status: number | null;
  stdout: string;
  output: string;
}

function normalizeCandidatePath(target: string): string {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let lastReal = parsed.root;
  let restIndex = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(lastReal, segments[i]);
    try {
      if (lstatSync(next).isSymbolicLink()) {
        restIndex = i;
        break;
      }
      lastReal = next;
    } catch {
      restIndex = i;
      break;
    }
  }
  let base: string;
  try {
    base = realpathSync.native(lastReal);
  } catch {
    base = lastReal;
  }
  const resolved = restIndex < segments.length ? path.join(base, ...segments.slice(restIndex)) : base;
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeCandidatePath(root), normalizeCandidatePath(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function identifyGlobalPackageManager(
  packageFile: string,
  roots: Partial<Record<GlobalPackageManager, string>>,
): GlobalPackageManager | undefined {
  const matches = SUPPORTED_MANAGERS.filter((manager) =>
    roots[manager] && isWithin(roots[manager], packageFile));
  return matches.length === 1 ? matches[0] : undefined;
}

export function packageRemovalArguments(manager: GlobalPackageManager): string[] {
  return manager === 'pnpm'
    ? ['remove', '--global', BRC_PACKAGE_NAME]
    : ['uninstall', '--global', BRC_PACKAGE_NAME];
}

export function isGlobalPackageManager(value: unknown): value is GlobalPackageManager {
  return value === 'pnpm' || value === 'npm';
}

export class GlobalPackageRemoval {
  constructor(private readonly installedFile: string) {}

  detectManager(): GlobalPackageManager {
    const roots: Partial<Record<GlobalPackageManager, string>> = {};
    for (const manager of SUPPORTED_MANAGERS) {
      try {
        const result = this.run(manager, ['root', '--global']);
        const root = result.stdout.trim();
        if (result.status === 0 && path.isAbsolute(root)) roots[manager] = root;
      } catch {
        // An unavailable manager cannot be the owner of this installation.
      }
    }
    const manager = identifyGlobalPackageManager(this.installedFile, roots);
    if (!manager) {
      throw new Error('Cannot identify the global npm/pnpm installation that owns BRC. No BRC data was removed.');
    }
    return manager;
  }

  remove(manager: GlobalPackageManager): CommandOutput {
    if (!isGlobalPackageManager(manager)) throw new Error('Unsupported global package manager.');
    const result = this.run(manager, packageRemovalArguments(manager));
    if (result.status !== 0) {
      throw new Error(manager + ' global uninstall failed: ' + result.output.trim());
    }
    return result;
  }

  private run(manager: GlobalPackageManager, args: readonly string[]): CommandOutput {
    const { command, isShim } = this.resolveCommand(manager);
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const commandLine = [command, ...args].map(quote).join(' ');
    const result = spawnSync(
      isShim ? process.env.ComSpec || 'cmd.exe' : command,
      isShim ? ['/d', '/s', '/c', '"' + commandLine + '"'] : [...args],
      {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: isShim,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout || '',
      output: (result.stdout || '') + (result.stderr || ''),
    };
  }

  private resolveCommand(manager: GlobalPackageManager): { command: string; isShim: boolean } {
    if (process.platform !== 'win32') return { command: manager, isShim: false };
    const lookup = spawnSync('where.exe', [manager], { encoding: 'utf8', windowsHide: true });
    if (lookup.error) throw lookup.error;
    if (lookup.status !== 0) throw new Error(manager + ' is not installed.');
    const commands = lookup.stdout.split(/\r?\n/).filter(Boolean);
    const command = commands.find((value) => /\.exe$/i.test(value))
      ?? commands.find((value) => /\.(?:cmd|bat)$/i.test(value));
    if (!command) throw new Error(manager + ' executable was not found.');
    return { command, isShim: /\.(?:cmd|bat)$/i.test(command) };
  }
}
