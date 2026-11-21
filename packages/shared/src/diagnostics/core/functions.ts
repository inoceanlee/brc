export type FunctionKind = 'sync' | 'async';

export interface FunctionTimingEntry {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: FunctionKind;
  calls: number;
  totalMs: number;
  maxMs: number;
  asyncWallMs: number;
  errors: number;
}

export interface FunctionTimingSnapshot {
  schema: 1;
  totalCalls: number;
  entries: FunctionTimingEntry[];
  truncated: boolean;
  droppedIds: number;
  failures: FunctionFailureSample[];
}

export interface FunctionDescriptor {
  name: string;
  file: string;
  line: number;
  kind: FunctionKind;
}

export interface FunctionTimingOptions {
  maxEntries?: number;
  clock?: () => number;
  describe?: (id: string) => FunctionDescriptor | undefined;
}

export interface FunctionTimingToken {
  readonly id: string;
  readonly root: boolean;
  readonly started: number;
  readonly kind: FunctionKind;
}

export const DEFAULT_MAX_FUNCTION_ENTRIES = 2_000;

interface Aggregate {
  calls: number;
  totalMs: number;
  maxMs: number;
  asyncWallMs: number;
  errors: number;
}

const MAX_FAILURE_TEXT = 512;

function describeFailure(id: string, error: unknown): FunctionFailureSample {
  const err = error instanceof Error ? error : undefined;
  const message = err?.message ?? (typeof error === 'string' ? error : String(error));
  const rawStack = err?.stack ?? '';
  return {
    id,
    message: message.slice(0, MAX_FAILURE_TEXT),
    stack: rawStack.slice(0, MAX_FAILURE_TEXT),
  };
}

/**
 * Bounded in-memory aggregation of own function calls. Only the outermost
 * invocation of a given function contributes time, so recursive and
 * re-entrant calls add call counts without double-counting the same work.
 * Async functions record wall-clock time from call to settlement.
 */
export class FunctionTiming {
  private readonly aggregates = new Map<string, Aggregate>();
  private readonly descriptors = new Map<string, FunctionDescriptor>();
  private readonly active = new Map<string, Set<FunctionTimingToken>>();
  private readonly failures = new Map<string, FunctionFailureSample>();
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly describe?: (id: string) => FunctionDescriptor | undefined;
  private droppedIds = 0;
  private totalCalls = 0;

  constructor(options: FunctionTimingOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_FUNCTION_ENTRIES;
    this.clock = options.clock ?? (() => performance.now());
    this.describe = options.describe;
  }

  begin(id: string, kind: FunctionKind = 'sync'): FunctionTimingToken | undefined {
    let aggregate = this.aggregates.get(id);
    if (!aggregate) {
      if (this.aggregates.size >= this.maxEntries) {
        this.droppedIds += 1;
        return undefined;
      }
      aggregate = { calls: 0, totalMs: 0, maxMs: 0, asyncWallMs: 0, errors: 0 };
      this.aggregates.set(id, aggregate);
    }
    const tokens = this.active.get(id) ?? new Set<FunctionTimingToken>();
    const token: FunctionTimingToken = { id, root: tokens.size === 0, started: this.clock(), kind };
    tokens.add(token);
    this.active.set(id, tokens);
    this.totalCalls += 1;
    aggregate.calls += 1;
    return token;
  }

  end(token: FunctionTimingToken | undefined, failed = false, error?: unknown): void {
    if (!token) return;
    const tokens = this.active.get(token.id);
    if (tokens) {
      tokens.delete(token);
      if (tokens.size === 0) this.active.delete(token.id);
    }
    const aggregate = this.aggregates.get(token.id);
    if (!aggregate) return;
    if (failed) {
      aggregate.errors += 1;
      if (!this.failures.has(token.id)) {
        this.failures.set(token.id, describeFailure(token.id, error));
      }
    }
    if (!token.root) return;
    const duration = Math.max(0, this.clock() - token.started);
    aggregate.totalMs += duration;
    if (duration > aggregate.maxMs) aggregate.maxMs = duration;
    if (token.kind === 'async') aggregate.asyncWallMs += duration;
  }

  failureSamples(): FunctionFailureSample[] {
    return [...this.failures.values()];
  }

  snapshot(limit = this.maxEntries): FunctionTimingSnapshot {
    const entries: FunctionTimingEntry[] = [];
    for (const [id, aggregate] of this.aggregates) {
      const descriptor = this.descriptors.get(id) ?? this.describe?.(id) ?? {
        name: id,
        file: '',
        line: 0,
        kind: 'sync' as const,
      };
      entries.push({
        id,
        name: descriptor.name,
        file: descriptor.file,
        line: descriptor.line,
        kind: descriptor.kind,
        calls: aggregate.calls,
        totalMs: Math.round(aggregate.totalMs * 1000) / 1000,
        maxMs: Math.round(aggregate.maxMs * 1000) / 1000,
        asyncWallMs: Math.round(aggregate.asyncWallMs * 1000) / 1000,
        errors: aggregate.errors,
      });
    }
    entries.sort((left, right) => right.totalMs - left.totalMs || left.id.localeCompare(right.id));
    const truncated = entries.length > limit;
    return {
      schema: 1,
      totalCalls: this.totalCalls,
      entries: truncated ? entries.slice(0, limit) : entries,
      truncated,
      droppedIds: this.droppedIds,
      failures: this.failureSamples(),
    };
  }

  /** Merges one pre-recorded call captured before the probe was installed. */
  recordEarly(record: EarlyRecord): void {
    let aggregate = this.aggregates.get(record.id);
    if (!aggregate) {
      if (this.aggregates.size >= this.maxEntries) {
        this.droppedIds += 1;
        return;
      }
      aggregate = { calls: 0, totalMs: 0, maxMs: 0, asyncWallMs: 0, errors: 0 };
      this.aggregates.set(record.id, aggregate);
    }
    aggregate.calls += 1;
    this.totalCalls += 1;
    if (record.failed) {
      aggregate.errors += 1;
      if (!this.failures.has(record.id)) {
        this.failures.set(record.id, describeFailure(record.id, record.error));
      }
    }
    aggregate.totalMs += record.durationMs;
    if (record.durationMs > aggregate.maxMs) aggregate.maxMs = record.durationMs;
    if (record.kind === 'async') aggregate.asyncWallMs += record.durationMs;
  }

  /** Registers source metadata produced by the build-time instrumenter. */
  register(id: string, descriptor: FunctionDescriptor): void {
    this.descriptors.set(id, descriptor);
  }

  reset(): void {
    this.aggregates.clear();
    this.active.clear();
    this.droppedIds = 0;
    this.totalCalls = 0;
  }
}

export interface FunctionFailureSample {
  id: string;
  message: string;
  stack: string;
}

export interface FunctionProbeHost {
  __brcDiagBegin?: (id: string, kind?: string) => FunctionTimingToken | undefined;
  __brcDiagEnd?: (token: FunctionTimingToken | undefined, failed?: boolean, error?: unknown) => void;
}

export interface FunctionProbeInstallation {
  timing: FunctionTiming;
  uninstall(): void;
}

const EARLY_BUFFER_SYMBOL = Symbol.for('brc.diag.early');
const EARLY_BUFFER_LIMIT = 2_000;

interface EarlyRecord {
  id: string;
  kind: FunctionKind;
  started: number;
  durationMs: number;
  failed: boolean;
  error?: unknown;
}

export interface EarlyFunctionBuffer {
  begin(id: string, kind: FunctionKind, clock: number): { id: string; kind: FunctionKind; started: number };
  end(token: { id: string; kind: FunctionKind; started: number }, failed: boolean, clock: number, error?: unknown): void;
  drain(): EarlyRecord[];
  fork(): EarlyFunctionBuffer;
  readonly count: number;
}

function createEarlyBuffer(): EarlyFunctionBuffer {
  const records: EarlyRecord[] = [];
  return {
    begin(id, kind, clock) {
      return { id, kind, started: clock };
    },
    end(token, failed, clock, error) {
      if (records.length >= EARLY_BUFFER_LIMIT) return;
      records.push({
        id: token.id,
        kind: token.kind,
        started: token.started,
        durationMs: Math.max(0, clock - token.started),
        failed,
        error,
      });
    },
    drain() {
      return records.splice(0, records.length);
    },
    fork() {
      return createEarlyBuffer();
    },
    get count() {
      return records.length;
    },
  };
}

const globalWithEarly = globalThis as unknown as Record<symbol, EarlyFunctionBuffer | undefined>;
if (!globalWithEarly[EARLY_BUFFER_SYMBOL]) {
  globalWithEarly[EARLY_BUFFER_SYMBOL] = createEarlyBuffer();
}

function earlyBuffer(): EarlyFunctionBuffer {
  return globalWithEarly[EARLY_BUFFER_SYMBOL] ??= createEarlyBuffer();
}

/**
 * Publishes the instrumentation hooks used by build-time injected calls.
 * When diagnostics are disabled the hooks stay absent and instrumented code
 * only performs one failed property lookup per call.
 */
export function installFunctionProbe(
  timing: FunctionTiming,
  host: FunctionProbeHost = globalThis as unknown as FunctionProbeHost,
): FunctionProbeInstallation {
  for (const record of earlyBuffer().drain()) timing.recordEarly(record);
  host.__brcDiagBegin = (id, kind) => timing.begin(id, kind === 'async' ? 'async' : 'sync');
  host.__brcDiagEnd = (token, failed, error) => timing.end(token, failed === true, error);
  return {
    timing,
    uninstall: () => {
      delete host.__brcDiagBegin;
      delete host.__brcDiagEnd;
    },
  };
}

function installEarlyProbe(host: FunctionProbeHost): void {
  if (host.__brcDiagBegin) return;
  host.__brcDiagBegin = (id, kind) => {
    const buffer = earlyBuffer();
    const token = buffer.begin(id, kind === 'async' ? 'async' : 'sync', performance.now());
    return token as unknown as FunctionTimingToken;
  };
  host.__brcDiagEnd = (token, failed, error) => {
    if (!token) return;
    const record = token as unknown as { id: string; kind: FunctionKind; started: number };
    earlyBuffer().end(record, failed === true, performance.now(), error);
  };
}

installEarlyProbe(globalThis as unknown as FunctionProbeHost);
