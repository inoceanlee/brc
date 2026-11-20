import { spawn, spawnSync } from 'node:child_process';

export function interruptChild(child, platform = process.platform, kill = process.kill) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    kill(-child.pid, 'SIGINT');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export class ReleaseRunner {
  constructor({ output = process.stdout, errorOutput = process.stderr } = {}) {
    this.output = output;
    this.errorOutput = errorOutput;
    this.child = null;
    this.interrupted = false;
    this.onInterrupt = () => {
      this.interrupted = true;
      interruptChild(this.child);
    };
  }

  async run(file, args, { cwd, env = process.env, interactive = false, onOutput } = {}) {
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
    const child = spawn(file, args, {
      cwd, env, shell, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.interrupted = false;
    process.on('SIGINT', this.onInterrupt);
    const chunks = { stdout: '', stderr: '' };
    let tail = '';
    const capture = (stream, data) => {
      const text = data.toString('utf8');
      chunks[stream] += text;
      if (chunks[stream].length > 4 * 1024 * 1024) chunks[stream] = chunks[stream].slice(-2 * 1024 * 1024);
      tail = (tail + text).slice(-12000);
      if (onOutput) onOutput(stream, text);
      if (interactive) (stream === 'stdout' ? this.output : this.errorOutput).write(text);
    };
    if (!interactive) {
      child.stdout.on('data', (data) => capture('stdout', data));
      child.stderr.on('data', (data) => capture('stderr', data));
    }
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0
          ? resolve()
          : reject(new Error('Command failed (' + (code ?? 'terminated') + '): ' + file + ' ' + args[0] + '\n' + tail.slice(-2400))));
      });
      return chunks;
    } finally {
      this.child = null;
      process.removeListener('SIGINT', this.onInterrupt);
    }
  }
}
