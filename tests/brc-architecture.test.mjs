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
const SERVICE_TYPES = /(?:Manager|Store|Service|Server|Sampler|Session|Controller|Provider|Tracker|History|Hub|Transport|Client|Dispatcher|Recorder|Logger)$/;
const LEGACY_ARCHITECTURE_VIOLATIONS = [
  'agent/adapters/network/feature-flags.ts: exported mutable service featureFlagManager',
  'agent/adapters/storage/config-manager.ts: exported mutable service configManager',
  'agent/adapters/storage/config-manager.ts: nested service construction YamlSettingsStore',
  'agent/adapters/system/search-manager.ts: exported mutable service searchManager',
  'agent/adapters/telemetry/fuzzySearchLogger.ts: exported mutable service fuzzySearchLogger',
  'agent/adapters/telemetry/toolHistory.ts: exported mutable service toolHistory',
  'agent/adapters/telemetry/usageTracker.ts: exported mutable service usageTracker',
  'agent/adapters/terminal/command-manager.ts: exported mutable service commandManager',
  'agent/adapters/terminal/terminal-manager.ts: exported mutable service terminalManager',
  'cli/adapters/storage/lock.ts: nested service construction LockStore',
];

const ENTRY_FILES = new Set(['cli.ts', 'main.ts', 'composition.ts']);

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

// Service names and types identify candidates. Constructor and field ownership
// indicate retained services; method-local objects are excluded unless retained.
function ownershipViolations(source, prefix, relative) {
  const violations = [];
  const declarations = new Map();
  const exported = new Set();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const mutable = !(statement.declarationList.flags & ts.NodeFlags.Const);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.set(declaration.name.text, { declaration, mutable });
        if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          exported.add(declaration.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exported.add(statement.expression.text);
    }
  }
  for (const name of exported) {
    const item = declarations.get(name);
    if (!item?.mutable) continue;
    const type = item.declaration.type?.getText(source) ?? '';
    if (SERVICE_TYPES.test(name) || SERVICE_TYPES.test(type)) {
      violations.push(prefix + ': exported mutable service ' + name);
    }
  }
  if (ENTRY_FILES.has(relative)) return violations;
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const className = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (className !== 'AbortController' && SERVICE_TYPES.test(className)) {
        let parent = node.parent;
        let retained = false;
        while (parent && parent !== source) {
          if (ts.isPropertyDeclaration(parent) || ts.isConstructorDeclaration(parent)) retained = true;
          if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(parent.left) && parent.left.expression.kind === ts.SyntaxKind.ThisKeyword) retained = true;
          if (ts.isFunctionLike(parent) && !ts.isConstructorDeclaration(parent)) break;
          parent = parent.parent;
        }
        if (retained && !inCore(relative)) violations.push(prefix + ': nested service construction ' + className);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

function crossPackageInternal(specifier, filename, root, pkg) {
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(filename), specifier);
    const packagesRoot = path.join(repository, 'packages');
    const relative = path.relative(packagesRoot, target).replaceAll('\\', '/');
    const [targetPackage, ...parts] = relative.split('/');
    return PACKAGE_NAMES.includes(targetPackage) && targetPackage !== pkg && parts[0] === 'src';
  }
  const match = /^@inoceanlee\/brc-(cli|relay|agent|shared)\/(.+)$/.exec(specifier);
  return Boolean(match && match[1] !== pkg);
}

async function architectureViolations() {
  const violations = [];
  for (const pkg of PACKAGE_NAMES) {
    const root = path.join(repository, 'packages', pkg, 'src');
    for (const filename of await sourceFiles(root)) {
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const prefix = pkg + '/' + relative;
      violations.push(...ownershipViolations(source, prefix, relative));
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
          if (crossPackageInternal(specifier, filename, root, pkg)) {
            violations.push(prefix + ': core imports cross-package internal ' + specifier);
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

test('ownership gate detects exported aliases and retained services but excludes one-shot objects', () => {
  const source = ts.createSourceFile('sample.ts', `
    let current: SearchManager;
    export { current as search };
    export let tracker: UsageTracker;
    class Adapter {
      store = new CacheStore();
      constructor() { this.logger = new DiagnosticLogger(); }
      refresh() { this.manager = new SearchManager(); }
      request() { return new AbortController(); }
      once() { const session = new RequestSession(); return session; }
    }
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(source, 'agent/adapters/sample.ts', 'adapters/sample.ts').sort(), [
    'agent/adapters/sample.ts: exported mutable service current',
    'agent/adapters/sample.ts: exported mutable service tracker',
    'agent/adapters/sample.ts: nested service construction CacheStore',
    'agent/adapters/sample.ts: nested service construction DiagnosticLogger',
    'agent/adapters/sample.ts: nested service construction SearchManager',
  ]);
  assert.deepEqual(ownershipViolations(source, 'agent/cli.ts', 'cli.ts').filter((v) => v.includes('nested')), []);
});

test('core import gate detects cross-package internals and permits package entry points', () => {
  const root = path.join(repository, 'packages', 'agent', 'src');
  const filename = path.join(root, 'core', 'sample.ts');
  assert.equal(crossPackageInternal('@inoceanlee/brc-shared/diagnostics/core', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('../../../shared/src/diagnostics/core', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('@inoceanlee/brc-shared', filename, root, 'agent'), false);
  assert.equal(crossPackageInternal('../adapters/store.js', filename, root, 'agent'), false);
});

test('architecture gate rejects any violation when the baseline is empty', () => {
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
