import { performance } from 'node:perf_hooks';
import { clearProgressLine, formatElapsed, progressFrame } from '../packages/shared/dist/progress/core.js';
import { RELEASE_CONFIG } from './release-config.mjs';

export class ReleaseProgress {
  constructor({ output = process.stdout, verbose = false } = {}) {
    this.output = output;
    this.verbose = verbose;
    this.current = null;
    this.frame = 0;
    this.timer = null;
  }

  print(message) {
    this.clear();
    this.output.write(message + '\n');
  }

  start(stage, { interactive = false } = {}) {
    this.finish();
    this.current = { stage, started: performance.now(), lastHeartbeat: performance.now(), detail: '' };
    this.output.write('  ' + stage + '\n');
    if (!interactive) {
      this.timer = setInterval(() => this.render(), RELEASE_CONFIG.progressIntervalMs);
      this.timer.unref?.();
    }
  }

  detail(message) {
    if (!this.current) return;
    this.current.detail = message;
    if (this.verbose) this.print('  ' + message);
  }

  render() {
    if (!this.current) return;
    const elapsed = formatElapsed(performance.now() - this.current.started);
    const detail = this.current.detail ? ' · ' + this.current.detail : '';
    if (this.output.isTTY) {
      const frame = progressFrame(this.frame++);
      this.output.write(clearProgressLine(true) + frame + ' ' + this.current.stage + detail + ' · ' + elapsed);
    } else if (performance.now() - this.current.lastHeartbeat >= RELEASE_CONFIG.progressHeartbeatMs) {
      this.current.lastHeartbeat = performance.now();
      this.output.write('  … ' + this.current.stage + detail + ' · ' + elapsed + '\n');
    }
  }

  clear() {
    if (this.output.isTTY && this.current) this.output.write(clearProgressLine(true));
  }

  finish(result) {
    if (!this.current) return;
    clearInterval(this.timer);
    this.timer = null;
    const elapsed = formatElapsed(performance.now() - this.current.started);
    this.clear();
    if (result instanceof Error) this.output.write('  ✗ ' + this.current.stage + ' · ' + elapsed + '\n');
    else this.output.write('  ✓ ' + this.current.stage + ' · ' + elapsed + '\n');
    this.current = null;
  }
}
