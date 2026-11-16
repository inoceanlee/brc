import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsInteractiveInput } from '../packages/cli/dist/commands/setup.js';

test('terminal prompts require stdin and stderr TTY independently from stdout', () => {
  assert.equal(allowsInteractiveInput({ stdinTTY: true, stderrTTY: true, stdoutTTY: false }), true);
  assert.equal(allowsInteractiveInput({ stdinTTY: false, stderrTTY: true, stdoutTTY: true }), false);
  assert.equal(allowsInteractiveInput({ stdinTTY: true, stderrTTY: false, stdoutTTY: true }), false);
});

test('CI and --no-input prohibit prompts unless explicitly overridden by --interactive', () => {
  assert.equal(allowsInteractiveInput({ stdinTTY: true, stderrTTY: true, ci: true }), false);
  assert.equal(allowsInteractiveInput({ stdinTTY: true, stderrTTY: true, ci: true, interactive: true }), true);
  assert.equal(allowsInteractiveInput({ stdinTTY: true, stderrTTY: true, interactive: true, noInput: true }), false);
});
