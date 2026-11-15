// Loaded only for the separate diagnostic cycle, not the five benchmark samples.
import { appendFileSync } from 'node:fs';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { LifecycleLock } from '../packages/cli/dist/adapters/storage/lock.js';
import { ProcessManager } from '../packages/cli/dist/adapters/process/controller.js';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';

const output = process.env.BENCHMARK_PHASE_FILE;
if (!output) throw new Error('BENCHMARK_PHASE_FILE is required.');
function instrument(target, method, label) {
  const original = target[method];
  if (typeof original !== 'function') return;
  target[method] = function (...args) {
    const started = performance.now();
    const service = args[0]?.name;
    const record = () => appendFileSync(output, `${JSON.stringify({ phase: label, service, ms: performance.now() - started })}\n`);
    try {
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') return result.finally(record);
      record();
      return result;
    } catch (error) {
      record();
      throw error;
    }
  };
}
instrument(SettingsManager, 'load', 'settings.load');
instrument(LifecycleLock.prototype, 'runExclusive', 'lock.runExclusive');
instrument(ProcessManager.prototype, 'start', 'process.start');
instrument(ProcessManager.prototype, 'status', 'process.status');
instrument(ProcessManager.prototype, 'inspectForStatus', 'process.inspectForStatus');
instrument(ServiceManager.prototype, 'withLock', 'services.withLock');
instrument(ServiceManager.prototype, 'status', 'services.status');
