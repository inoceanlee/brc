import { execSync } from 'child_process';
import { existsSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';

let cachedRgPath: string | null = null;

/**
 * Resolve ripgrep binary path with multiple fallback strategies
 * This handles cases where @vscode/ripgrep postinstall fails in npx environments
 */
export async function getRipgrepPath(): Promise<string> {
  if (cachedRgPath) {
    return cachedRgPath;
  }


  try {
    const { rgPath } = await import('@vscode/ripgrep');
    if (existsSync(rgPath)) {

      if (process.platform !== 'win32') {
        try {
          chmodSync(rgPath, 0o755);
        } catch (e) {
        }
      }
      cachedRgPath = rgPath;
      return rgPath;
    }
  } catch (e) {
  }


  try {
    const systemRg = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${whichCmd} ${systemRg}`, { encoding: 'utf-8', windowsHide: true }).trim().split(/\r?\n/)[0];
    if (result && existsSync(result)) {
      cachedRgPath = result;
      return result;
    }
  } catch (e) {

  }


  const commonPaths: string[] = [];

  if (process.platform === 'win32') {
    commonPaths.push(
      'C:\\Program Files\\Ripgrep\\rg.exe',
      'C:\\Program Files (x86)\\Ripgrep\\rg.exe',
      path.join(os.homedir(), 'scoop', 'apps', 'ripgrep', 'current', 'rg.exe'),
      path.join(os.homedir(), '.cargo', 'bin', 'rg.exe')
    );
  } else {
    commonPaths.push(
      '/usr/local/bin/rg',
      '/usr/bin/rg',
      path.join(os.homedir(), '.cargo', 'bin', 'rg'),
      '/opt/homebrew/bin/rg' 
    );
  }

  for (const possiblePath of commonPaths) {
    if (existsSync(possiblePath)) {
      cachedRgPath = possiblePath;
      return possiblePath;
    }
  }


  throw new Error(
    'ripgrep binary not found. Desktop Commander requires ripgrep to perform searches. ' +
    'Please install ripgrep:\n' +
    '  macOS: brew install ripgrep\n' +
    '  Linux: See https://github.com/BurntSushi/ripgrep#installation\n' +
    '  Windows: choco install ripgrep or download from https://github.com/BurntSushi/ripgrep/releases'
  );
}

/**
 * Clear the cached ripgrep path (useful for testing)
 */
export function clearRipgrepCache(): void {
  cachedRgPath = null;
}
