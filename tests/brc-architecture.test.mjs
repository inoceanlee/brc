import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cliSrc = fileURLToPath(new URL('../packages/cli/src/', import.meta.url));
const FORBIDDEN_IN_CORE = ['node:fs', 'node:net', 'node:http', 'node:child_process', 'node:dgram'];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

test('CLI core rules do not depend on file, network or process adapters', async () => {
  const core = path.join(cliSrc, 'core');
  const files = await sourceFiles(core);
  assert.ok(files.length >= 3, 'core layer must contain the lifecycle rules');
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const moduleName of FORBIDDEN_IN_CORE) {
      if (source.includes(`from '${moduleName}`)) {
        violations.push(`${path.relative(cliSrc, file)} imports ${moduleName}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('adapters hold the external integrations used by the CLI lifecycle', async () => {
  for (const relative of [
    'adapters/process/controller.ts',
    'adapters/process/identity.ts',
    'adapters/storage/lock.ts',
    'adapters/storage/cleanup.ts',
    'core/lifecycle/ports.ts',
    'core/lifecycle/policy.ts',
    'core/lifecycle/workflow.ts',
  ]) {
    await assert.doesNotReject(readFile(path.join(cliSrc, relative), 'utf8'), relative);
  }
});

test('diagnostics infrastructure is reachable from the shared package', async () => {
  const shared = fileURLToPath(new URL('../packages/shared/src/', import.meta.url));
  for (const relative of [
    'diagnostics/core/event.ts',
    'diagnostics/core/ports.ts',
    'diagnostics/core/functions.ts',
    'diagnostics/core/recorder.ts',
    'diagnostics/core/session.ts',
    'diagnostics/runtime.ts',
    'diagnostics/adapters/logging.ts',
    'diagnostics/adapters/log-lock.ts',
    'diagnostics/adapters/snapshots.ts',
    'diagnostics/adapters/resources-node.ts',
  ]) {
    await assert.doesNotReject(readFile(path.join(shared, relative), 'utf8'), relative);
  }
});
import ts from 'typescript';

const repository = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_NAMES = ['cli', 'relay', 'agent', 'shared'];
const EXTERNAL_IO = /^(?:node:)?(?:fs(?:\/promises)?|net|http|https|child_process|dgram|os|worker_threads|tty|readline|console|stream|process)(?:\/.*)?$/;
const EXTERNAL_SDK = /^(?:express|ws|better-sqlite3|sqlite3|proper-lockfile|@modelcontextprotocol\/|@sqlite\/)/;
const SERVICE_TYPES = /(?:Manager|Store|Service|Server|Sampler|Session|Controller|Provider|Tracker|Hub|Transport|Client|Dispatcher|Recorder|Logger)$/;
const LEGACY_ARCHITECTURE_VIOLATIONS = [
  "agent/adapters/telemetry/fuzzySearchLogger.ts: module-level service singleton FuzzySearchLogger",
  "agent/adapters/telemetry/usageTracker.ts: module-level service singleton UsageTracker",
  "agent/adapters/terminal/terminal-manager.ts: module-level service singleton TerminalManager",
  "agent/core/command-manager.ts: core constructs CommandManager",
  "agent/core/config-manager.ts: core constructs ConfigManager",
  "agent/core/config-manager.ts: core imports external dependency fs",
  "agent/core/config-manager.ts: core imports external dependency os",
  "agent/core/config-storage.ts: core imports external dependency fs",
  "agent/core/config-storage.ts: core imports external dependency fs/promises",
  "agent/core/config-storage.ts: core imports external dependency proper-lockfile",
  "agent/core/config.ts: core imports external dependency fs",
  "agent/core/config.ts: core imports external dependency os",
  "agent/core/handlers/filesystem-handlers.ts: core imports adapter ../../adapters/filesystem/files/base.js",
  "agent/core/handlers/filesystem-handlers.ts: core imports external dependency os",
  "agent/core/handlers/history-handlers.ts: core imports adapter ../../adapters/telemetry/toolHistory.js",
  "agent/core/handlers/transfer-handlers.ts: core imports adapter ../../adapters/filesystem/file-transfer.js",
  "agent/core/search-manager.ts: core constructs SearchManager",
  "agent/core/search-manager.ts: core imports adapter ../adapters/filesystem/files/index.js",
  "agent/core/search-manager.ts: core imports adapter ../adapters/system/ripgrep-resolver.js",
  "agent/core/search-manager.ts: core imports external dependency child_process",
  "agent/core/search-manager.ts: core imports external dependency fs/promises",
  "agent/core/tool-definitions.ts: core imports adapter ../adapters/system/system-info.js",
  "agent/core/tools/config.ts: core imports adapter ../../adapters/system/system-info.js",
  "agent/core/tools/config.ts: core imports external dependency node:fs",
  "agent/core/tools/config.ts: core imports external dependency node:fs/promises",
  "agent/core/tools/edit.ts: core imports adapter ../../adapters/filesystem/files/factory.js",
  "agent/core/tools/edit.ts: core imports adapter ../../adapters/telemetry/fuzzySearchLogger.js",
  "agent/core/tools/edit.ts: core imports external dependency fs/promises",
  "agent/core/tools/feedback.ts: core imports adapter ../../adapters/telemetry/usageTracker.js",
  "agent/core/tools/feedback.ts: core imports external dependency child_process",
  "agent/core/tools/feedback.ts: core imports external dependency os",
  "agent/core/tools/filesystem.ts: core imports adapter ../../adapters/filesystem/files/base.js",
  "agent/core/tools/filesystem.ts: core imports adapter ../../adapters/filesystem/files/index.js",
  "agent/core/tools/filesystem.ts: core imports external dependency child_process",
  "agent/core/tools/filesystem.ts: core imports external dependency fs/promises",
  "agent/core/tools/filesystem.ts: core imports external dependency os",
  "agent/core/tools/fuzzySearch.ts: core imports external dependency worker_threads",
  "agent/core/tools/improved-process-tools.ts: core imports adapter ../../adapters/system/process-detection.js",
  "agent/core/tools/improved-process-tools.ts: core imports adapter ../../adapters/terminal/terminal-manager.js",
  "agent/core/tools/improved-process-tools.ts: core imports external dependency child_process",
  "agent/core/tools/improved-process-tools.ts: core imports external dependency fs/promises",
  "agent/core/tools/improved-process-tools.ts: core imports external dependency os",
  "agent/core/tools/pdf/manipulations.ts: core imports external dependency fs/promises",
  "agent/core/tools/pdf/markdown.ts: core imports external dependency fs",
  "agent/core/tools/pdf/markdown.ts: core imports external dependency fs/promises",
  "agent/core/tools/process.ts: core imports external dependency child_process",
  "agent/core/tools/process.ts: core imports external dependency os",
  "agent/core/tools/prompts.ts: core imports adapter ../../adapters/telemetry/usageTracker.js",
  "agent/core/tools/prompts.ts: core imports external dependency fs/promises",
  "agent/core/tools/usage.ts: core imports adapter ../../adapters/telemetry/usageTracker.js",
  "agent/core/types.ts: core imports external dependency child_process",
  "agent/core/utils/capture.ts: core imports adapter ../../adapters/system/system-info.js",
  "agent/core/utils/capture.ts: core imports external dependency https",
  "agent/core/utils/capture.ts: core imports external dependency os",
  "agent/core/utils/dockerPrompt.ts: core imports adapter ../../adapters/telemetry/usageTracker.js",
  "agent/core/utils/feature-flags.ts: core constructs FeatureFlagManager",
  "agent/core/utils/feature-flags.ts: core imports adapter ../../adapters/telemetry/logger.js",
  "agent/core/utils/feature-flags.ts: core imports external dependency fs",
  "agent/core/utils/feature-flags.ts: core imports external dependency fs/promises",
  "agent/core/utils/welcome-onboarding.ts: core imports adapter ../../adapters/system/open-browser.js",
  "agent/core/utils/welcome-onboarding.ts: core imports adapter ../../adapters/telemetry/logger.js",
  "cli/core/lifecycle/workflow.ts: core constructs ProcessManager",
  "cli/core/lifecycle/workflow.ts: core imports adapter ../../adapters/process/controller.js",
  "cli/core/lifecycle/workflow.ts: core imports adapter ../../adapters/storage/lock.js",
  "relay/core/auth/provider.ts: core constructs RelayClientsStore",
  "relay/core/auth/provider.ts: core imports adapter ../../adapters/storage/sqlite.js",
  "relay/core/auth/provider.ts: core imports external dependency @modelcontextprotocol/sdk/server/auth/clients.js",
  "relay/core/auth/provider.ts: core imports external dependency @modelcontextprotocol/sdk/server/auth/errors.js",
  "relay/core/auth/provider.ts: core imports external dependency @modelcontextprotocol/sdk/server/auth/provider.js",
  "relay/core/auth/provider.ts: core imports external dependency @modelcontextprotocol/sdk/server/auth/types.js",
  "relay/core/auth/provider.ts: core imports external dependency @modelcontextprotocol/sdk/shared/auth.js",
  "relay/core/auth/provider.ts: core imports external dependency express",
  "relay/core/auth/sessions.ts: core imports external dependency express",
];

function inCore(relative) {
  return /(?:^|\/)core\//.test(relative);
}

function importNames(source) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

async function architectureViolations() {
  const violations = [];
  for (const pkg of PACKAGE_NAMES) {
    const root = path.join(repository, 'packages', pkg, 'src');
    for (const filename of await sourceFiles(root)) {
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const prefix = pkg + '/' + relative;
      if (inCore(relative)) {
        for (const specifier of new Set(importNames(source))) {
          if (EXTERNAL_IO.test(specifier) || EXTERNAL_SDK.test(specifier)) {
            violations.push(prefix + ': core imports external dependency ' + specifier);
          }
          if (specifier.startsWith('.') && /(?:^|\/)adapters(?:\/|$)/.test(
            path.relative(root, path.resolve(path.dirname(filename), specifier)).replaceAll('\\', '/')
          )) {
            violations.push(prefix + ': core imports adapter ' + specifier);
          }
        }
      }
      function visit(node) {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && SERVICE_TYPES.test(node.expression.text)) {
          const className = node.expression.text;
          if (className === 'AbortController') return;
          if (inCore(relative)) violations.push(prefix + ': core constructs ' + className);
          else if (node.parent && ts.isVariableDeclaration(node.parent) && node.parent.parent
            && ts.isVariableDeclarationList(node.parent.parent)
            && node.parent.parent.parent && ts.isVariableStatement(node.parent.parent.parent)
            && node.parent.parent.parent.parent === source && !['cli.ts', 'index.ts', 'main.ts'].includes(relative)) {
            violations.push(prefix + ': module-level service singleton ' + className);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  return violations.sort();
}

function unexpectedArchitectureViolations(actual, baseline) {
  const allowed = new Set(baseline);
  return actual.filter((entry) => !allowed.has(entry));
}

test('removing an approved legacy violation does not block independent package work', () => {
  const removed = LEGACY_ARCHITECTURE_VIOLATIONS.slice(1);
  assert.deepEqual(unexpectedArchitectureViolations(removed, LEGACY_ARCHITECTURE_VIOLATIONS), []);
  assert.deepEqual(
    unexpectedArchitectureViolations([...removed, 'relay/core/auth/unknown.ts: core imports external dependency fs'], LEGACY_ARCHITECTURE_VIOLATIONS),
    ['relay/core/auth/unknown.ts: core imports external dependency fs'],
  );
});

test('Core boundaries and long-lived object ownership reject new violations per file', async () => {
  const actual = await architectureViolations();
  if (process.env.BRC_ARCHITECTURE_PRINT_BASELINE === '1') {
    process.stdout.write('ARCHITECTURE_BASELINE=' + JSON.stringify(actual) + '\n');
  }
  assert.deepEqual(unexpectedArchitectureViolations(actual, LEGACY_ARCHITECTURE_VIOLATIONS), []);
});
