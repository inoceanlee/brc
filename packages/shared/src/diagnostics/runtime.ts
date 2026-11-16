export {
  startDiagnostics,
  resolveDiagnosticsSettings,
} from './adapters/legacy-runtime.js';
export type {
  DiagnosticsRuntimeOptions,
  DiagnosticsLogOptions,
  DiagnosticsRuntime,
} from './adapters/legacy-runtime.js';
export { createDiagnosticsRuntime } from './core/runtime.js';
export type {
  InjectedDiagnosticsOptions,
  InjectedDiagnosticsRuntime,
  DiagnosticMessageOptions,
  DiagnosticSessionPort,
  ResourceSamplerLifecyclePort,
} from './core/runtime.js';
