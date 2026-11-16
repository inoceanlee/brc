import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ServerResult } from '../../core/types.js';
import { resolveAgentPaths } from '../storage/agent-paths.js';
import { ToolHistoryStorage } from './toolHistoryStorage.js';

export interface ToolCallRecord {
  timestamp: string;
  toolName: string;
  arguments: any;
  output: ServerResult;
  duration?: number;
}

interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
  timestamp: string; // formatted local time string
}

// Format timestamp in local timezone for display
function formatLocalTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function trimHistory(lines: string[], targetBytes: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (kept.length > 0 && bytes + lineBytes > targetBytes) break;
    kept.push(lines[i]);
    bytes += lineBytes;
  }
  return kept.reverse();
}

export class ToolHistory {
  private history: ToolCallRecord[] = [];
  private readonly MAX_ENTRIES = 1000;
  private readonly MAX_HISTORY_FILE_SIZE_BYTES = 5 * 1024 * 1024;
  // When the file exceeds the cap we trim it down to this target instead of
  // all the way to zero, so a single overflow doesn't cause every subsequent
  // flush to re-trim.
  private readonly HISTORY_FILE_TRIM_TARGET_BYTES = 4 * 1024 * 1024;
  private readonly storage: ToolHistoryStorage;
  private writeQueue: ToolCallRecord[] = [];
  private isWriting = false;
  private writeInterval?: NodeJS.Timeout;

  constructor() {
    this.storage = new ToolHistoryStorage(resolveAgentPaths().historyDirectory);
    this.migrateLegacyHistory();

    // Load existing history on startup
    this.loadFromDisk();
    
    // Start async write processor
    this.startWriteProcessor();
  }

  private migrateLegacyHistory(): void {
    if (existsSync(this.storage.file)) return;
    const paths = resolveAgentPaths();
    const candidates = [path.join(paths.historyDirectory, 'tool-history.jsonl')];
    const defaultRoot = resolveAgentPaths({ ...process.env, BRC_DATA_ROOT: undefined }).root;
    if (path.normalize(paths.root).toLowerCase() === path.normalize(defaultRoot).toLowerCase()) {
      candidates.push(path.join(paths.legacyDirectory, 'tool-history.jsonl'));
    }
    for (const legacy of candidates) {
      if (!existsSync(legacy)) continue;
      const stat = lstatSync(legacy);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Legacy Agent history must be a plain file.');
      const lines = readFileSync(legacy, 'utf8').split('\n').filter((line) => line.trim());
      const records = lines.map((line) => JSON.parse(line) as ToolCallRecord);
      if (records.some((record) => !record || typeof record.toolName !== 'string')) {
        throw new Error('Legacy Agent history contains invalid records.');
      }
      const safe = records.slice(-this.MAX_ENTRIES).map((record) => ({
        timestamp: record.timestamp, toolName: record.toolName,
        arguments: {}, output: this.capOutput(record.output ?? { content: [] }),
        ...(Number.isFinite(record.duration) ? { duration: record.duration } : {}),
      }));
      this.storage.withLock(() => {
        if (existsSync(this.storage.file)) throw new Error('Agent history was created during migration.');
        this.storage.rewriteText(safe.map((record) => JSON.stringify(record)).join('\n') + (safe.length ? '\n' : ''));
      });
      if (JSON.parse(readFileSync(this.storage.file, 'utf8')).length !== safe.length) {
        throw new Error('Migrated Agent history failed verification.');
      }
      unlinkSync(legacy);
      return;
    }
  }

  private loadFromDisk(): void {
    this.storage.withLock(() => this.loadLocked());
  }

  private loadLocked(): void {
      if (this.storage.size() === 0) return;

      // If the file is over the cap, trim it down before reading so we
      // load a bounded amount.
      this.trimHistoryFileIfTooLarge();

      const content = this.storage.readText();
      if (content === null) return;
      const lines = content.trim().split('\n').filter(line => line.trim());

      // Parse each line as JSON
      const records: ToolCallRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (e) {
          // Silently skip invalid lines
        }
      }

      // Keep only last 1000 entries, and cap on the way IN as well as on the
      // way out. Entries written before the cap existed are still on disk and
      // are well under the whole-file trim threshold, so without this the cap
      // does nothing for anyone upgrading with an existing history file — i.e.
      // for everyone it was written for.
      this.history = records
        .slice(-this.MAX_ENTRIES)
        .map(record => ({ ...record, arguments: {}, output: this.capOutput(record.output) }));

      // If file is getting too large, trim it
      if (lines.length > this.MAX_ENTRIES * 2) {
        this.trimHistoryFile();
      }
  }

  /**
   * Trim the on-disk history file to stay under the size cap by dropping the
   * oldest entries (lines) until the kept tail fits within the trim target.
   * Returns true only when the file was actually rewritten with a smaller
   * tail, so callers can fall through to their normal path on failure or
   * no-op rather than mutating in-memory state.
   *
   * Always keeps at least the most recent entry, even if a single record
   * exceeds the trim target — there is no useful state below that.
   */
  private trimHistoryFileIfTooLarge(): boolean {
    try {
      if (this.storage.size() <= this.MAX_HISTORY_FILE_SIZE_BYTES) return false;
      const content = this.storage.readText();
      if (content === null) return false;
      const lines = content.split('\n').filter(line => line.length > 0);
      if (lines.length === 0) {
        return false;
      }

      const kept = trimHistory(lines, this.HISTORY_FILE_TRIM_TARGET_BYTES);
      this.storage.rewriteText(kept.join('\n') + '\n');
      return true;
    } catch (error) {
      // Trim failed; do not claim the file was changed.
      return false;
    }
  }

  /**
   * Trim history file to prevent it from growing indefinitely
   */
  private trimHistoryFile(): void {
    try {
      // Keep last 1000 entries in memory
      const keepEntries = this.history.slice(-this.MAX_ENTRIES);

      // Write them back
      const lines = keepEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      this.storage.rewriteText(lines);
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Async write processor - batches writes to avoid blocking
   */
  private startWriteProcessor(): void {
    this.writeInterval = setInterval(() => {
      if (this.writeQueue.length > 0 && !this.isWriting) {
        this.flushToDisk();
      }
    }, 1000); // Flush every second
    
    // Prevent interval from keeping process alive during shutdown/tests
    this.writeInterval.unref();
  }

  /**
   * Flush queued writes to disk
   */
  private async flushToDisk(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) return;

    this.isWriting = true;
    const toWrite = [...this.writeQueue];
    this.writeQueue = [];

    try {
      this.storage.withLock(() => {
        // Read and compact while holding the same lock as every writer.
        this.trimHistoryFileIfTooLarge();
        const lines = toWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        this.storage.appendText(lines);
      });
    } catch (error) {
      // Put back in queue on failure
      this.writeQueue.unshift(...toWrite);
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Add a tool call to history
   */
  /**
   * Replace an oversized output with a short marker. Keeps the record shape
   * ({ content: [...] }) so readers and formatters need no special case.
   */
  private capOutput(output: ServerResult): ServerResult {
    return { content: [{ type: 'text', text: '[tool output omitted from persisted history]' }], isError: output.isError } as ServerResult;
  }

  addCall(
    toolName: string,
    args: any,
    output: ServerResult,
    duration?: number
  ): void {
    const record: ToolCallRecord = {
      timestamp: new Date().toISOString(),
      toolName,
      arguments: {},
      output: this.capOutput(output),
      duration
    };

    this.history.push(record);

    // Keep only last 1000 in memory
    if (this.history.length > this.MAX_ENTRIES) {
      this.history.shift();
    }
    
    // Queue for async write
    this.writeQueue.push(record);
  }

  /**
   * Get recent tool calls with filters
   */
  getRecentCalls(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): ToolCallRecord[] {
    let results = [...this.history];

    // Filter by tool name
    if (options.toolName) {
      results = results.filter(r => r.toolName === options.toolName);
    }

    // Filter by timestamp
    if (options.since) {
      const sinceDate = new Date(options.since);
      results = results.filter(r => new Date(r.timestamp) >= sinceDate);
    }

    // Limit results (default 50, max 1000)
    const limit = Math.min(options.maxResults || 50, 1000);
    return results.slice(-limit);
  }

  /**
   * Get recent calls formatted with local timezone
   */
  getRecentCallsFormatted(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): FormattedToolCallRecord[] {
    const calls = this.getRecentCalls(options);
    
    // Format timestamps to local timezone
    return calls.map(call => ({
      ...call,
      timestamp: formatLocalTimestamp(call.timestamp)
    }));
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      totalEntries: this.history.length,
      oldestEntry: this.history[0]?.timestamp,
      newestEntry: this.history[this.history.length - 1]?.timestamp,
      historyFile: this.storage.file,
      queuedWrites: this.writeQueue.length
    };
  }

  /**
   * Cleanup method - clears interval and flushes pending writes
   * Call this during shutdown or in tests
   */
  async cleanup(): Promise<void> {
    // Clear the interval
    if (this.writeInterval) {
      clearInterval(this.writeInterval);
      this.writeInterval = undefined;
    }
    
    // Flush any remaining writes
    if (this.writeQueue.length > 0) {
      await this.flushToDisk();
    }
  }
}

export let toolHistory: ToolHistory;
export function attachToolHistory(instance: ToolHistory): void { toolHistory = instance; }
