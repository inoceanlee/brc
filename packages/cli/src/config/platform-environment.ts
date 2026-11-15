import os from 'node:os';
import path from 'node:path';

export interface PlatformTarget {
  platform: 'windows' | 'linux' | 'darwin';
  arch: 'amd64' | 'arm64';
  archiveExt: 'zip' | 'tar.gz';
  executableName: string;
}

export interface BrcPaths {
  root: string;
  traefik: string;
  config: string;
  data: string;
  runtime: string;
  logs: string;
  diagnostics: string;
  tmp: string;
}

export interface PlatformEnvironmentOptions {
  platform?: NodeJS.Platform | string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

export class PlatformEnvironment {
  private readonly platform: string;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: string;

  constructor(optionsOrEnv?: PlatformEnvironmentOptions | NodeJS.ProcessEnv) {
    if (optionsOrEnv && ('env' in optionsOrEnv || 'platform' in optionsOrEnv || 'arch' in optionsOrEnv || 'homedir' in optionsOrEnv)) {
      const opts = optionsOrEnv as PlatformEnvironmentOptions;
      this.platform = opts.platform ?? process.platform;
      this.arch = opts.arch ?? process.arch;
      this.env = opts.env ?? process.env;
      this.homedir = opts.homedir ?? os.homedir();
    } else if (optionsOrEnv) {
      this.platform = process.platform;
      this.arch = process.arch;
      this.env = optionsOrEnv as NodeJS.ProcessEnv;
      this.homedir = os.homedir();
    } else {
      this.platform = process.platform;
      this.arch = process.arch;
      this.env = process.env;
      this.homedir = os.homedir();
    }
  }

  resolveBrcPaths(): BrcPaths {
    const isWin = this.platform === 'win32' || this.platform === 'windows';
    const p = isWin ? path.win32 : path.posix;

    let root: string;
    if (this.env.BRC_DATA_ROOT) {
      root = p.resolve(this.env.BRC_DATA_ROOT);
    } else if (isWin) {
      const localAppData = this.env.LOCALAPPDATA || p.join(this.homedir, 'AppData', 'Local');
      root = p.resolve(p.join(localAppData, 'BRC'));
    } else if (this.platform === 'darwin') {
      root = p.resolve(p.join(this.homedir, 'Library', 'Application Support', 'brc'));
    } else {
      const xdgDataHome = this.env.XDG_DATA_HOME || p.join(this.homedir, '.local', 'share');
      root = p.resolve(p.join(xdgDataHome, 'brc'));
    }

    return {
      root,
      traefik: p.join(root, 'traefik'),
      config: p.join(root, 'config'),
      data: p.join(root, 'data'),
      runtime: p.join(root, 'runtime'),
      logs: p.join(root, 'logs'),
      diagnostics: p.join(root, 'diagnostics'),
      tmp: p.join(root, 'tmp'),
    };
  }

  resolveTraefikTarget(): PlatformTarget {
    let platform: 'windows' | 'linux' | 'darwin';
    let archiveExt: 'zip' | 'tar.gz';
    let executableName: string;

    switch (this.platform) {
      case 'win32':
      case 'windows':
        platform = 'windows';
        archiveExt = 'zip';
        executableName = 'traefik.exe';
        break;
      case 'linux':
        platform = 'linux';
        archiveExt = 'tar.gz';
        executableName = 'traefik';
        break;
      case 'darwin':
        platform = 'darwin';
        archiveExt = 'tar.gz';
        executableName = 'traefik';
        break;
      default:
        throw new Error(`Unsupported platform for Traefik: ${this.platform}`);
    }

    let arch: 'amd64' | 'arm64';
    switch (this.arch) {
      case 'x64':
      case 'amd64':
        arch = 'amd64';
        break;
      case 'arm64':
        arch = 'arm64';
        break;
      default:
        throw new Error(`Unsupported architecture for Traefik: ${this.arch}`);
    }

    return {
      platform,
      arch,
      archiveExt,
      executableName,
    };
  }
}
