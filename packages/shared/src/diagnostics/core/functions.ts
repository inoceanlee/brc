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

  end(token: FunctionTimingToken | undefined, failed = false): void {
    if (!token) return;
    const tokens = this.active.get(token.id);
    if (tokens) {
      tokens.delete(token);
      if (tokens.size === 0) this.active.delete(token.id);
    }
    const aggregate = this.aggregates.get(token.id);
    if (!aggregate) return;
    if (failed) aggregate.errors += 1;
    if (!token.root) return;
    const duration = Math.max(0, this.clock() - token.started);
    aggregate.totalMs += duration;
    if (duration > aggregate.maxMs) aggregate.maxMs = duration;
    if (token.kind === 'async') aggregate.asyncWallMs += duration;
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
    };
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

export interface FunctionProbeHost {
  __brcDiagBegin?: (id: string, kind?: string) => FunctionTimingToken | undefined;
  __brcDiagEnd?: (token: FunctionTimingToken | undefined, failed?: boolean) => void;
}

export interface FunctionProbeInstallation {
  timing: FunctionTiming;
  uninstall(): void;
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
  host.__brcDiagBegin = (id, kind) => timing.begin(id, kind === 'async' ? 'async' : 'sync');
  host.__brcDiagEnd = (token, failed) => timing.end(token, failed === true);
  return {
    timing,
    uninstall: () => {
      delete host.__brcDiagBegin;
      delete host.__brcDiagEnd;
    },
  };
}
