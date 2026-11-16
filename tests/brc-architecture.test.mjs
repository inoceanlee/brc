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
const SERVICE_TYPES = /(?:Manager|Store|Storage|Lock|Service|Server|Sampler|Session|Controller|Provider|Tracker|History|Hub|Transport|Client|Dispatcher|Recorder|Logger)$/;
const LEGACY_ARCHITECTURE_VIOLATIONS = [
  'agent/adapters/network/feature-flags.ts: exported mutable service featureFlagManager',
  'agent/adapters/storage/config-manager.ts: exported mutable service configManager',
  'agent/adapters/storage/config-manager.ts: nested service construction YamlSettingsStore@87',
  'agent/adapters/storage/config-manager.ts: nested service construction FileSettingsLock@90',
  'agent/adapters/storage/config-manager.ts: nested service construction ConfigStorage@94',
  'agent/adapters/storage/config-manager.ts: nested service construction ConfigStorage@95',
  'agent/adapters/system/search-manager.ts: exported mutable service searchManager',
  'agent/adapters/telemetry/fuzzySearchLogger.ts: exported mutable service fuzzySearchLogger',
  'agent/adapters/telemetry/logger.ts: module service object logger',
  'agent/adapters/telemetry/toolHistory.ts: nested service construction ToolHistoryStorage@59',
  'agent/adapters/telemetry/toolHistory.ts: exported mutable service toolHistory',
  'agent/adapters/telemetry/usageTracker.ts: exported mutable service usageTracker',
  'agent/adapters/terminal/command-manager.ts: exported mutable service commandManager',
  'agent/adapters/terminal/terminal-manager.ts: exported mutable service terminalManager',
  'cli/adapters/storage/lock.ts: nested service construction LockStore@50',
  'shared/diagnostics/adapters/legacy-runtime.ts: nested service construction NodeResourceSampler@118',
  'shared/diagnostics/adapters/legacy-runtime.ts: nested service construction FileSnapshotStore@120',
  'shared/diagnostics/adapters/legacy-runtime.ts: nested service construction DiagnosticSession@124',
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

// Type references and retained constructions are candidates, not client data.
// Line numbers distinguish separate legacy instances in the same file.
function ownershipViolations(source, prefix, relative) {
  const violations = [];
  if (ENTRY_FILES.has(relative)) return violations;
  const exported = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text);
    }
  }
  function serviceType(node) {
    if (!node) return false;
    if (ts.isTypeReferenceNode(node)) return SERVICE_TYPES.test(node.typeName.getText(source));
    return Boolean(ts.forEachChild(node, serviceType));
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const mutable = !(statement.declarationList.flags & ts.NodeFlags.Const);
      if (mutable && serviceType(declaration.type)) {
        const label = isExported || exported.has(name) ? 'exported mutable service ' : 'module service reference ';
        violations.push(prefix + ': ' + label + name);
      }
      if (!mutable && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)
        && /(?:logger|manager|service|tracker)$/i.test(name)
        && declaration.initializer.properties.some((property) => ts.isMethodDeclaration(property)
          || (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))))) {
        violations.push(prefix + ': module service object ' + name);
      }
    }
  }
  function capturedByReturnedClosure(declaration, seen = new Set()) {
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    if (seen.has(name)) return false;
    seen.add(name);
    let scope = declaration.parent;
    while (scope && scope !== source && !ts.isFunctionLike(scope)) scope = scope.parent;
    if (!scope || scope === source) return false;
    function containsName(node) {
      return (ts.isIdentifier(node) && node.text === name) || Boolean(ts.forEachChild(node, containsName));
    }
    function findClosure(node) {
      if (ts.isReturnStatement(node) && node.expression) {
        function closureReferences(child) {
          if ((ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isMethodDeclaration(child))
            && containsName(child)) return true;
          if ((ts.isShorthandPropertyAssignment(child) && child.name.text === name)
            || (ts.isPropertyAssignment(child) && containsName(child.initializer))) return true;
          return Boolean(ts.forEachChild(child, closureReferences));
        }
        if (closureReferences(node.expression)) return true;
      }
      return Boolean(ts.forEachChild(node, findClosure));
    }
    if (findClosure(scope.body)) return true;
    function retainedByAnother(node) {
      if (ts.isVariableDeclaration(node) && node !== declaration && node.initializer
        && containsName(node.initializer) && capturedByReturnedClosure(node, new Set(seen))) return true;
      return Boolean(ts.forEachChild(node, retainedByAnother));
    }
    return retainedByAnother(scope.body);
  }
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const className = serviceConstructionName(node);
      if (className) {
        let parent = node.parent;
        let retained = false;
        while (parent && parent !== source) {
          if (ts.isPropertyDeclaration(parent)) retained = true;
          if (ts.isBinaryExpression(parent)
            && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && ts.isPropertyAccessExpression(parent.left) && parent.left.expression.kind === ts.SyntaxKind.ThisKeyword) retained = true;
          if (ts.isVariableDeclaration(parent) && capturedByReturnedClosure(parent)) retained = true;
          if (ts.isFunctionLike(parent)) break;
          parent = parent.parent;
        }
        if (retained && !inCore(relative)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(prefix + ': nested service construction ' + className + '@' + line);
        }
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
    const relative = path.relative(path.join(repository, 'packages'), target).replaceAll('\\', '/');
    const [targetPackage, ...parts] = relative.split('/');
    return PACKAGE_NAMES.includes(targetPackage) && targetPackage !== pkg
      && (parts[0] === 'src' || parts[0] === 'dist') && parts.length > 1;
  }
  const match = /^(brc-agent|brc-relay|brc-shared|@inoceanlee\/brc)\/.+$/.exec(specifier);
  const names = { 'brc-agent': 'agent', 'brc-relay': 'relay', 'brc-shared': 'shared', '@inoceanlee/brc': 'cli' };
  return Boolean(match && names[match[1]] !== pkg);
}

async function sharedAdapterExports() {
  const root = path.join(repository, 'packages', 'shared', 'src');
  const names = new Set();
  for (const filename of await sourceFiles(root)) {
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    if (!relative.includes('/adapters/') && !/^managed-(?:control|log)\.ts$/.test(relative)) continue;
    const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

function sharedAdapterImports(source, adapterNames) {
  const found = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== 'brc-shared' || !statement.importClause || statement.importClause.isTypeOnly) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) found.push('*');
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && adapterNames.has(name)) found.push(name);
      }
    }
  }
  return found;
}

function isNodeAsyncContext(node) {
  const expression = node.expression;
  return node.getSourceFile().statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !['async_hooks', 'node:async_hooks'].includes(statement.moduleSpecifier.text)) return false;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && ts.isIdentifier(expression)) {
      return bindings.elements.some((item) => (item.propertyName ?? item.name).text === 'AsyncLocalStorage'
        && item.name.text === expression.text);
    }
    return Boolean(bindings && ts.isNamespaceImport(bindings) && ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression) && expression.expression.text === bindings.name.text
      && expression.name.text === 'AsyncLocalStorage');
  });
}

function serviceConstructionName(node) {
  if (!ts.isNewExpression(node)) return '';
  const name = ts.isIdentifier(node.expression) ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
  return name !== 'AbortController' && !isNodeAsyncContext(node) && SERVICE_TYPES.test(name) ? name : '';
}

async function architectureViolations() {
  const violations = [];
  const adapterNames = await sharedAdapterExports();
  for (const pkg of PACKAGE_NAMES) {
    const root = path.join(repository, 'packages', pkg, 'src');
    for (const filename of await sourceFiles(root)) {
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const prefix = pkg + '/' + relative;
      violations.push(...ownershipViolations(source, prefix, relative));
      if (inCore(relative)) {
        for (const name of sharedAdapterImports(source, adapterNames)) {
          violations.push(prefix + ': core imports shared adapter ' + name);
        }
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
        const className = serviceConstructionName(node);
        if (className) {
          if (inCore(relative)) violations.push(prefix + ': core constructs ' + className);
          else if (node.parent && ts.isVariableDeclaration(node.parent) && node.parent.parent
            && ts.isVariableDeclarationList(node.parent.parent)
            && node.parent.parent.parent && ts.isVariableStatement(node.parent.parent.parent)
            && node.parent.parent.parent.parent === source && !['cli.ts', 'index.ts', 'main.ts'].includes(relative)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            violations.push(prefix + ': module-level service singleton ' + className + '@' + line);
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
  const allowed = new Map();
  for (const entry of baseline) allowed.set(entry, (allowed.get(entry) ?? 0) + 1);
  return actual.filter((entry) => {
    const count = allowed.get(entry) ?? 0;
    if (!count) return true;
    allowed.set(entry, count - 1);
    return false;
  });
}

test('ownership gate detects retained services and excludes transient objects and client data', () => {
  const source = ts.createSourceFile('sample.ts', `
let current: SearchManager;
export { current as search };
export let tracker: UsageTracker | undefined;
let hidden: SearchManager;
export let currentClient: { name: string; version: string };
export let currentRemoteClient: { name?: string } | null = null;
export const logger = { info: () => {} };
class Adapter {
  store = new CacheStore();
  constructor() { this.logger = new DiagnosticLogger(); const session = new RequestSession(); session.close(); }
  refresh() { this.manager ??= new services.SearchManager(); }
  once() { const session = new RequestSession(); return session; }
}
function factory() {
  const store = new FileSnapshotStore();
  const sampler = new NodeResourceSampler();
  const session = new DiagnosticSession({ store, sampler });
  return { stop: () => session.stop() };
}
`, ts.ScriptTarget.Latest, true);
  const actual = ownershipViolations(source, 'agent/adapters/sample.ts', 'adapters/sample.ts').sort();
  assert.deepEqual(actual, [
    'agent/adapters/sample.ts: exported mutable service current',
    'agent/adapters/sample.ts: exported mutable service tracker',
    'agent/adapters/sample.ts: module service object logger',
    'agent/adapters/sample.ts: module service reference hidden',
    'agent/adapters/sample.ts: nested service construction CacheStore@10',
    'agent/adapters/sample.ts: nested service construction DiagnosticLogger@11',
    'agent/adapters/sample.ts: nested service construction DiagnosticSession@18',
    'agent/adapters/sample.ts: nested service construction FileSnapshotStore@16',
    'agent/adapters/sample.ts: nested service construction NodeResourceSampler@17',
    'agent/adapters/sample.ts: nested service construction SearchManager@12',
  ]);
  assert.deepEqual(ownershipViolations(source, 'agent/cli.ts', 'cli.ts'), []);
  const baseline = ['x: nested service construction LockStore@1'];
  assert.deepEqual(unexpectedArchitectureViolations([baseline[0], baseline[0]], baseline), baseline);
  assert.deepEqual(unexpectedArchitectureViolations([baseline[0], 'x: nested service construction LockStore@2'], baseline),
    ['x: nested service construction LockStore@2']);
});

test('core import gate detects actual package internals and permits public entry points', () => {
  const root = path.join(repository, 'packages', 'agent', 'src');
  const filename = path.join(root, 'core', 'sample.ts');
  assert.equal(crossPackageInternal('brc-shared/dist/config/core/settings.js', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('brc-relay/dist/adapters/http.js', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('@inoceanlee/brc/dist/adapters/store.js', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('../../../shared/src/diagnostics/core', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('../../../shared/dist/config/core/settings.js', filename, root, 'agent'), true);
  assert.equal(crossPackageInternal('brc-shared', filename, root, 'agent'), false);
  assert.equal(crossPackageInternal('../adapters/store.js', filename, root, 'agent'), false);
});

test('shared public entry distinguishes adapter values and core contracts', async () => {
  const source = ts.createSourceFile('sample.ts', `
    import { FileSnapshotStore, DEFAULT_SETTINGS } from 'brc-shared';
    import type { DiagnosticLogPort } from 'brc-shared';
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(sharedAdapterImports(source, await sharedAdapterExports()), ['FileSnapshotStore']);
});
test('node async context is not a long-lived external service', () => {
  const source = ts.createSourceFile('sample.ts', `
    import { AsyncLocalStorage as ContextStorage } from 'node:async_hooks';
    import * as hooks from 'async_hooks';
    const context = new ContextStorage();
    class Adapter {
      context = new hooks.AsyncLocalStorage();
      store = new FileSnapshotStore();
    }
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(source, 'agent/adapters/sample.ts', 'adapters/sample.ts'), [
    'agent/adapters/sample.ts: nested service construction FileSnapshotStore@7',
  ]);
  const other = ts.createSourceFile('sample.ts', `
    import { AsyncLocalStorage } from './external.js';
    class Adapter { context = new AsyncLocalStorage(); }
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(other, 'agent/adapters/sample.ts', 'adapters/sample.ts'), [
    'agent/adapters/sample.ts: nested service construction AsyncLocalStorage@3',
  ]);
});

test('core construction detects namespace-qualified services', () => {
  const source = ts.createSourceFile('core.ts', 'new services.SearchManager(); new AbortController();', ts.ScriptTarget.Latest, true);
  const names = [];
  function visit(node) {
    const name = serviceConstructionName(node);
    if (name) names.push(name);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(names, ['SearchManager']);
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
