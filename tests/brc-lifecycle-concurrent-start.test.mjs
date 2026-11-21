import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceManager } from '../packages/cli/dist/core/lifecycle/workflow.js';

const paths = () => ({ root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' });

test('independent services start concurrently instead of serially', async () => {
  const services = ['relay', 'traefik', 'agent'].map((name) => ({ name, entrypoint: '/test', workspaceRoot: '/', cwd: '/' }));
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const processes = {
    status: async (spec) => ({ name: spec.name, state: 'stopped', pid: null, detail: 'No managed process record.' }),
    start: async (spec) => {
      started.push(spec.name);
      await gate;
    },
    stop: async () => {},
  };
  const manager = new ServiceManager(paths(), services, processes, { check: async () => ({ ready: true, detail: '' }) }, { runExclusive: (run) => run() });

  const starting = manager.start();
  // All three starts must be dispatched before any of them resolves.
  const deadline = Date.now() + 2000;
  while (started.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual([...started].sort(), ['agent', 'relay', 'traefik'], 'all services must begin starting concurrently');
  release();
  await starting;
});
