import type { ToolHistoryEntry, ToolHistoryStorePort } from 'brc-shared';
import { ServerResult } from '../../core/types.js';

export interface ToolCallRecord {
  timestamp: string;
  toolName: string;
  arguments: unknown;
  output: ServerResult;
  duration?: number;
}

interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
  timestamp: string;
}

function formatLocalTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export class ToolHistory {
  private history: ToolCallRecord[] = [];
  private readonly MAX_ENTRIES = 1000;
  private readonly store: ToolHistoryStorePort;
  private writeQueue: ToolCallRecord[] = [];
  private isWriting = false;
  private writeInterval?: NodeJS.Timeout;

  constructor(
    store: ToolHistoryStorePort,
    private readonly reportWriteFailure: () => void,
    readonly target = '',
  ) {
    this.store = store;
    this.startWriteProcessor();
  }

  async load(): Promise<void> {
    const entries = await this.store.query({ maxResults: this.MAX_ENTRIES });
    this.history = entries.map((entry) => this.fromEntry(entry)).reverse();
  }

  private fromEntry(entry: ToolHistoryEntry): ToolCallRecord {
    if (!entry || typeof entry.toolName !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.toolName)
      || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new Error('Agent history contains an invalid record.');
    }
    return {
      timestamp: new Date(entry.timestamp).toISOString(),
      toolName: entry.toolName,
      arguments: {},
      output: { content: [], isError: entry.output?.isError === true } as ServerResult,
      ...(Number.isFinite(entry.duration) && entry.duration! >= 0 ? { duration: entry.duration } : {}),
    };
  }

  private toEntry(record: ToolCallRecord): ToolHistoryEntry {
    return {
      timestamp: record.timestamp,
      toolName: record.toolName,
      arguments: {},
      output: { isError: record.output.isError === true, content: [] },
      ...(record.duration !== undefined ? { duration: record.duration } : {}),
    };
  }

  private capOutput(output: ServerResult): ServerResult {
    return { content: [{ type: 'text', text: '[tool output omitted from persisted history]' }], isError: output.isError } as ServerResult;
  }

  private startWriteProcessor(): void {
    this.writeInterval = setInterval(() => {
      if (this.writeQueue.length > 0 && !this.isWriting) void this.flush();
    }, 1000);
    this.writeInterval.unref();
  }

  private async flush(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const pending = [...this.writeQueue];
    this.writeQueue = [];
    try {
      for (const record of pending) await this.store.append(this.toEntry(record));
      await this.store.prune(this.MAX_ENTRIES);
    } catch {
      this.writeQueue.unshift(...pending);
      try {
        this.reportWriteFailure();
      } catch {}
    } finally {
      this.isWriting = false;
    }
  }

  addCall(toolName: string, args: unknown, output: ServerResult, duration?: number): void {
    const record: ToolCallRecord = {
      timestamp: new Date().toISOString(),
      toolName,
      arguments: {},
      output: this.capOutput(output),
      duration,
    };
    this.history.push(record);
    if (this.history.length > this.MAX_ENTRIES) this.history.shift();
    this.writeQueue.push(record);
  }

  getRecentCalls(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): ToolCallRecord[] {
    let results = [...this.history];
    if (options.toolName) results = results.filter((record) => record.toolName === options.toolName);
    if (options.since) {
      const sinceDate = new Date(options.since);
      results = results.filter((record) => new Date(record.timestamp) >= sinceDate);
    }
    const limit = Math.min(options.maxResults || 50, this.MAX_ENTRIES);
    return results.slice(-limit);
  }

  getRecentCallsFormatted(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): FormattedToolCallRecord[] {
    return this.getRecentCalls(options).map((call) => ({
      ...call,
      timestamp: formatLocalTimestamp(call.timestamp),
    }));
  }

  getStats() {
    return {
      totalEntries: this.history.length,
      oldestEntry: this.history[0]?.timestamp,
      newestEntry: this.history[this.history.length - 1]?.timestamp,
      historyFile: this.target,
      queuedWrites: this.writeQueue.length,
    };
  }

  async cleanup(): Promise<void> {
    if (this.writeInterval) {
      clearInterval(this.writeInterval);
      this.writeInterval = undefined;
    }
    if (this.writeQueue.length > 0) await this.flush();
  }

  close(): void {
    const closable = this.store as ToolHistoryStorePort & { close?: () => void };
    closable.close?.();
  }
}
