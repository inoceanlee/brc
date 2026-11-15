import { readFile } from 'node:fs/promises';
import type { ResourcePeak, ResourceSample, ResourceSamplePort } from '../core/ports.js';

export interface NodeResourceSamplerOptions {
  intervalMs?: number;
  clock?: () => number;
  now?: () => Date;
}

const MEBIBYTE = 1024 * 1024;

async function systemPeakRss(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

/**
 * Continuous CPU and memory sampling for a long-lived Node process. The peak
 * is labelled `sampled` unless the platform exposes a real high-water mark,
 * so callers never mistake an observation maximum for a system peak.
 */
export class NodeResourceSampler implements ResourceSamplePort {
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private windowStarted: number;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuElapsed = 0;
  private peakRssBytes = 0;
  private peakWindowMs = 0;
  private cpuPercent: number | null = null;

  constructor(options: NodeResourceSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 100 || this.intervalMs > 60_000) {
      throw new Error('Resource sample interval must be between 100 and 60000 ms.');
    }
    this.clock = options.clock ?? (() => performance.now());
    this.now = options.now ?? (() => new Date());
    this.windowStarted = this.clock();
    this.lastCpuElapsed = this.windowStarted;
    this.peakRssBytes = process.memoryUsage().rss;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.observe(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private observe(): void {
    const usage = process.memoryUsage();
    if (usage.rss > this.peakRssBytes) this.peakRssBytes = usage.rss;
    const now = this.clock();
    const cpu = process.cpuUsage();
    const elapsedMs = now - this.lastCpuElapsed;
    if (elapsedMs > 0) {
      const usedMs = (cpu.user - this.lastCpuUsage.user) / 1_000 + (cpu.system - this.lastCpuUsage.system) / 1_000;
      this.cpuPercent = Math.round((usedMs / elapsedMs) * 1000) / 10;
    }
    this.lastCpuUsage = cpu;
    this.lastCpuElapsed = now;
    this.peakWindowMs = Math.max(this.peakWindowMs, now - this.windowStarted);
  }

  async sample(): Promise<ResourceSample> {
    this.observe();
    const memory = process.memoryUsage();
    if (memory.rss > this.peakRssBytes) this.peakRssBytes = memory.rss;
    const cpu = process.cpuUsage();
    const peakRss = await systemPeakRss();
    const peak: ResourcePeak | null = peakRss !== null
      ? { source: 'system', rssBytes: peakRss, windowMs: Math.round(this.peakWindowMs) }
      : { source: 'sampled', rssBytes: this.peakRssBytes, windowMs: Math.round(this.peakWindowMs) };
    return {
      schema: 1,
      capturedAt: this.now().toISOString(),
      source: 'node',
      windowMs: Math.round(this.peakWindowMs),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      cpuPercent: this.cpuPercent,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      peak,
    };
  }
}

/** Runs one short-lived sampling window; used by CLI and build scripts. */
export async function sampleNodeResources(windowMs = 0): Promise<ResourceSample> {
  const sampler = new NodeResourceSampler({ intervalMs: Math.max(100, Math.min(60_000, windowMs || 1_000)) });
  if (windowMs > 0) {
    sampler.start();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, windowMs);
    await promise;
    sampler.stop();
  }
  return sampler.sample();
}

export function formatResourceSummary(sample: ResourceSample): string {
  const rss = (sample.rssBytes / MEBIBYTE).toFixed(1);
  const peak = sample.peak
    ? `${(sample.peak.rssBytes / MEBIBYTE).toFixed(1)} MiB (${sample.peak.source}, ${sample.peak.windowMs} ms)`
    : 'unavailable';
  const cpu = sample.cpuPercent === null ? 'sampling' : `${sample.cpuPercent}%`;
  return `RSS ${rss} MiB, peak ${peak}, CPU ${cpu}, window ${sample.windowMs} ms`;
}
