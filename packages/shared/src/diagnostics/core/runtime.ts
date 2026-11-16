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
  captureSnapshot(status?: 'running' | 'exited'): Promise<void>;
  stop(): Promise<void>;
}

export function createDiagnosticsRuntime(options: InjectedDiagnosticsOptions): InjectedDiagnosticsRuntime {
  if (!options.enabled) {
    return { enabled: false, log: () => undefined, captureSnapshot: async () => undefined, stop: async () => undefined };
  }
  options.resources?.start();
  options.session?.start();
  let pending = Promise.resolve();
  return {
    enabled: true,
    functions: options.functions,
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
      pending = pending.then(() => options.log!.write(input)).catch(() => undefined);
    },
    async captureSnapshot(status = 'running') {
      await pending;
      await options.session?.capture(status);
    },
    async stop() {
      options.resources?.stop();
      await options.session?.stop();
      await pending;
      await options.log?.flush();
    },
  };
}
