import type { FunctionTiming } from './functions.js';
import type { DiagnosticComponent, DiagnosticEventInput, DiagnosticLevel } from './event.js';
import type { DiagnosticLogPort } from './ports.js';

export interface DiagnosticSessionPort {
  start(): void;
  capture(status: 'running' | 'exited'): Promise<unknown>;
  stop(): Promise<void>;
}

export interface ResourceSamplerLifecyclePort {
  start(): void;
  stop(): void;
}

export interface InjectedDiagnosticsOptions {
  enabled: boolean;
  component: DiagnosticComponent;
  instanceId?: string;
  functions?: FunctionTiming;
  log?: DiagnosticLogPort;
  session?: DiagnosticSessionPort;
  resources?: ResourceSamplerLifecyclePort;
}

export interface DiagnosticMessageOptions {
  level?: DiagnosticLevel;
  source?: DiagnosticEventInput['source'];
  errorCode?: string;
  error?: unknown;
  data?: Record<string, unknown>;
}

export interface InjectedDiagnosticsRuntime {
  enabled: boolean;
  functions?: FunctionTiming;
  log(message: string, options?: DiagnosticMessageOptions): void;
  getLogFailure(): Error | undefined;
  captureSnapshot(status?: 'running' | 'exited'): Promise<void>;
  stop(): Promise<void>;
}

export function createDiagnosticsRuntime(options: InjectedDiagnosticsOptions): InjectedDiagnosticsRuntime {
  if (!options.enabled) {
    return { enabled: false, log: () => undefined, getLogFailure: () => undefined, captureSnapshot: async () => undefined, stop: async () => undefined };
  }
  options.resources?.start();
  options.session?.start();
  let pending = Promise.resolve();
  let logFailure: Error | undefined;
  let stopPromise: Promise<void> | undefined;
  return {
    enabled: true,
    functions: options.functions,
    getLogFailure: () => logFailure,
    log(message, logOptions = {}) {
      if (!options.log) return;
      const error = logOptions.error;
      const input: DiagnosticEventInput = {
        component: options.component,
        level: logOptions.level ?? 'info',
        source: logOptions.source ?? { file: options.component },
        message,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        ...(logOptions.errorCode ? { errorCode: logOptions.errorCode } : {}),
        ...(error === undefined ? {} : { stack: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
        ...(logOptions.data ? { data: logOptions.data } : {}),
      };
      pending = pending.then(() => options.log!.write(input)).catch((error: unknown) => {
        logFailure ??= error instanceof Error ? error : new Error(String(error));
      });
    },
    async captureSnapshot(status = 'running') {
      await pending;
      await options.session?.capture(status);
    },
    stop() {
      return stopPromise ??= (async () => {
        const errors: unknown[] = [];
        try { options.resources?.stop(); } catch (error) { errors.push(error); }
        try { await options.session?.stop(); } catch (error) { errors.push(error); }
        await pending;
        try { await options.log?.flush(); } catch (error) { errors.push(error); }
        if (logFailure && !errors.includes(logFailure)) errors.push(logFailure);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Diagnostics shutdown failed.');
      })();
    },
  };
}
