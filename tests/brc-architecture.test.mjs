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
const SERVICE_TYPES = /(?:Manager|Store|Storage|Lock|Service|Server|Sampler|Session|Controller|Provider|Tracker|History|Hub|Transport|Client|Dispatcher|Recorder|Logger|Handler|Timing|DiagnosticLog)$/;

const ENTRY_FILES = new Set(['cli.ts', 'main.ts']);

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

// Findings use the enclosing declaration and target rather than source lines.
function constructionIdentity(node, source) {
  let owner = '<module>';
  let target = '<return>';
  for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
    if (target === '<return>' && ts.isVariableDeclaration(parent)) target = parent.name.getText(source);
    if (target === '<return>' && ts.isPropertyDeclaration(parent)) target = parent.name.getText(source);
    if (target === '<return>' && ts.isBinaryExpression(parent)
      && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      target = parent.left.getText(source);
    }
    if (ts.isConstructorDeclaration(parent)) owner = 'constructor';
    else if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) owner = parent.name.getText(source);
    else if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name) {
      owner = parent.name.text + '.' + owner;
      break;
    }
  }
  return owner + ':' + target;
}

function isControlledSelfConstruction(node) {
  if (!ts.isIdentifier(node.expression)) return false;
  let method = node.parent;
  while (method && !ts.isMethodDeclaration(method)) method = method.parent;
  if (!method || !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    || !ts.isClassDeclaration(method.parent) || method.parent.name?.text !== node.expression.text) return false;
  const methodName = method.name.getText(node.getSourceFile());
  if ((methodName === 'open' || methodName === 'load') && ts.isReturnStatement(node.parent)) return true;
  if (methodName !== 'initialize' || !ts.isVariableDeclaration(node.parent)
    || !ts.isIdentifier(node.parent.name)) return false;
  const list = node.parent.parent;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || list.declarations.length !== 1
    || !ts.isBlock(statement.parent)) return false;
  const statements = statement.parent.statements;
  const next = statements[statements.indexOf(statement) + 1];
  if (!next || !ts.isExpressionStatement(next) || !ts.isCallExpression(next.expression)
    || next.expression.arguments.length !== 0 || !ts.isPropertyAccessExpression(next.expression.expression)) return false;
  const access = next.expression.expression;
  return ts.isIdentifier(access.expression) && access.expression.text === node.parent.name.text && access.name.text === 'close';
}

function isDataInterface(statement) {
  return ts.isInterfaceDeclaration(statement) && statement.members.every((member) => {
    if (!ts.isPropertySignature(member) || !member.type) return false;
    function callable(node) {
      return ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)
        || ts.isCallSignatureDeclaration(node) || Boolean(ts.forEachChild(node, callable));
    }
    return !callable(member.type);
  });
}

function ownershipViolations(source, prefix, relative, dataTypes = new Set()) {
  const violations = [];
  if (ENTRY_FILES.has(relative)) return violations;
  for (const statement of source.statements) {
    if (isDataInterface(statement)) dataTypes.add(statement.name.text);
  }
  const exported = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add((element.propertyName ?? element.name).text);
    }
  }
  function serviceType(node) {
    if (!node) return false;
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(source);
      return !dataTypes.has(name) && SERVICE_TYPES.test(name);
    }
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
  const logFactories = new Set();
  const logNamespaces = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'brc-shared'
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const item of statement.importClause.namedBindings.elements) {
        if ((item.propertyName ?? item.name).text === 'createManagedLog') logFactories.add(item.name.text);
      }
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'brc-shared'
      && statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      logNamespaces.add(statement.importClause.namedBindings.name.text);
    }
  }
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const className = serviceConstructionName(node);
      if (className && !isControlledSelfConstruction(node)) {
        let parent = node.parent;
        let retained = /(?:Store|Storage|Lock|Timing|DiagnosticLog)$/.test(className);
        if (!/(?:Session|Transport)$/.test(className) && ts.isReturnStatement(node.parent)) retained = true;
        while (parent && parent !== source) {
          if (ts.isPropertyDeclaration(parent)) retained = true;
          if (ts.isBinaryExpression(parent)
            && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && ts.isPropertyAccessExpression(parent.left) && parent.left.expression.kind === ts.SyntaxKind.ThisKeyword) retained = true;
          if (ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)
            && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            retained = true;
          }
          if (ts.isVariableDeclaration(parent) && capturedByReturnedClosure(parent)) retained = true;
          if (ts.isFunctionLike(parent)) break;
          parent = parent.parent;
        }
        if (retained && !inCore(relative)) {
          violations.push(prefix + ': nested service construction ' + className + '@' + constructionIdentity(node, source));
        }
      }
    }
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && logFactories.has(node.expression.text))
      || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && logNamespaces.has(node.expression.expression.text) && node.expression.name.text === 'createManagedLog'))) {
      violations.push(prefix + ': service factory createManagedLog@' + constructionIdentity(node, source));
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
  async function exported(filename, seen) {
    if (seen.has(filename)) return new Map();
    const nextSeen = new Set(seen).add(filename);
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    const adapter = /(?:^|\/)adapters\//.test(relative);
    const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Map();
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
        const child = await exported(target, nextSeen);
        if (!statement.exportClause) {
          for (const [name, isAdapter] of child) names.set(name, isAdapter);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (!element.isTypeOnly) {
              const original = (element.propertyName ?? element.name).text;
              if (child.has(original)) names.set(element.name.text, child.get(original));
            }
          }
        }
      } else if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.set(statement.name.text, adapter);
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, adapter);
          }
        }
      }
    }
    return names;
  }
  const all = await exported(path.join(root, 'index.ts'), new Set());
  return new Set([...all].filter(([, adapter]) => adapter).map(([name]) => name));
}

function sharedAdapterImports(source, adapterNames) {
  const found = [];
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'brc-shared' && !statement.importClause?.isTypeOnly
      && statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      namespaces.add(statement.importClause.namedBindings.name.text);
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === 'brc-shared' && node.importClause && !node.importClause.isTypeOnly) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && adapterNames.has(name)) found.push(name);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text) && adapterNames.has(node.name.text)) found.push(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      && adapterNames.has(node.argumentExpression.text)) found.push(node.argumentExpression.text);
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'brc-shared') {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) found.push('*');
      else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && adapterNames.has(name)) found.push(name);
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'brc-shared'
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      let value = node;
      while (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent;
      const parent = value.parent;
      if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          if (element.dotDotDotToken || (element.propertyName && !ts.isIdentifier(element.propertyName)
            && !ts.isStringLiteral(element.propertyName))) found.push('*');
          else {
            const name = (element.propertyName ?? element.name).getText(source).replace(/^['"]|['"]$/g, '');
            if (adapterNames.has(name)) found.push(name);
          }
        }
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
        if (adapterNames.has(parent.name.text)) found.push(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === value
        && parent.argumentExpression && ts.isStringLiteral(parent.argumentExpression)) {
        if (adapterNames.has(parent.argumentExpression.text)) found.push(parent.argumentExpression.text);
      } else found.push('*');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
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
    const dataTypes = new Set();
    const files = await sourceFiles(root);
    for (const filename of files) {
      if (!inCore(path.relative(root, filename).replaceAll('\\', '/'))) continue;
      const core = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of core.statements) {
        if (isDataInterface(statement)) dataTypes.add(statement.name.text);
      }
    }
    for (const filename of files) {
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const prefix = pkg + '/' + relative;
      violations.push(...ownershipViolations(source, prefix, relative, new Set(dataTypes)));
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
            violations.push(prefix + ': module-level service singleton ' + className + '@' + constructionIdentity(node, source));
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
interface ActiveSession { pid: number; isBlocked: boolean; runtime: number }
let active: ActiveSession | undefined;
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
    'agent/adapters/sample.ts: nested service construction CacheStore@Adapter.<module>:store',
    'agent/adapters/sample.ts: nested service construction DiagnosticLogger@Adapter.constructor:this.logger',
    'agent/adapters/sample.ts: nested service construction DiagnosticSession@factory:session',
    'agent/adapters/sample.ts: nested service construction FileSnapshotStore@factory:store',
    'agent/adapters/sample.ts: nested service construction NodeResourceSampler@factory:sampler',
    'agent/adapters/sample.ts: nested service construction SearchManager@Adapter.refresh:this.manager',
  ]);
  const shifted = ts.createSourceFile('sample.ts', '\n\n' + source.text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(shifted, 'agent/adapters/sample.ts', 'adapters/sample.ts').sort(), actual);
  assert.deepEqual(ownershipViolations(source, 'agent/cli.ts', 'cli.ts'), []);
  const baseline = ['x: nested service construction LockStore@1'];
  assert.deepEqual(unexpectedArchitectureViolations([baseline[0], baseline[0]], baseline), baseline);
  assert.deepEqual(unexpectedArchitectureViolations([baseline[0], 'x: nested service construction LockStore@2'], baseline),
    ['x: nested service construction LockStore@2']);
});

test('ownership detects file handlers, local storage, assigned clients and service factories', () => {
  const source = ts.createSourceFile('sample.ts', `
    import { createManagedLog as makeLog } from 'brc-shared';
    let handler: TextFileHandler | null = null;
    function getHandler() { if (!handler) handler = new TextFileHandler(); return handler; }
    function run() {
      let client: WsClient | undefined;
      const stop = () => client?.stop();
      client = new WsClient();
      const store = new FileSnapshotStore();
      const log = makeLog('path', 1);
      return { stop, store, log };
    }
  `, ts.ScriptTarget.Latest, true);
  const actual = ownershipViolations(source, 'agent/adapters/sample.ts', 'adapters/sample.ts');
  assert.ok(actual.includes('agent/adapters/sample.ts: module service reference handler'));
  assert.ok(actual.includes('agent/adapters/sample.ts: nested service construction TextFileHandler@getHandler:handler'));
  assert.ok(actual.includes('agent/adapters/sample.ts: nested service construction WsClient@run:client'));
  assert.ok(actual.includes('agent/adapters/sample.ts: nested service construction FileSnapshotStore@run:store'));
  assert.ok(actual.includes('agent/adapters/sample.ts: service factory createManagedLog@run:log'));
});

test('ownership identifies diagnostics, direct service returns and callable interfaces', () => {
  const source = ts.createSourceFile('sample.ts', `
    import * as shared from 'brc-shared';
    interface UsageTracker { record: (event: string) => void }
    interface ActiveSession { pid: number; runtime: number }
    let tracker: UsageTracker;
    let active: ActiveSession;
    function timing() { const value = new FunctionTiming(); return value; }
    function logging() { const value = new FileDiagnosticLog(); return value; }
    function client() { return new WsClient(); }
    function manager() { return new SearchManager(); }
    function once() { return new RequestSession(); }
    function sink() { return shared.createManagedLog('log', 1, () => {}); }
  `, ts.ScriptTarget.Latest, true);
  const actual = ownershipViolations(source, 'agent/adapters/sample.ts', 'adapters/sample.ts');
  for (const expected of [
    'module service reference tracker',
    'nested service construction FunctionTiming@timing:value',
    'nested service construction FileDiagnosticLog@logging:value',
    'nested service construction WsClient@client:<return>',
    'nested service construction SearchManager@manager:<return>',
    'service factory createManagedLog@sink:<return>',
  ]) assert.ok(actual.includes('agent/adapters/sample.ts: ' + expected), expected);
  assert.equal(actual.some((item) => item.includes('active') || item.includes('RequestSession')), false);
  assert.deepEqual(ownershipViolations(source, 'agent/cli.ts', 'cli.ts'), []);
});

test('dynamic shared imports distinguish data from adapter values', () => {
  const source = ts.createSourceFile('sample.ts', `
    const { DEFAULT_SETTINGS } = await import('brc-shared');
    const { DEFAULT_SETTINGS: settings } = require('brc-shared');
    const { FileSnapshotStore: Snapshot } = await import('brc-shared');
    const { createManagedLog } = require('brc-shared');
    const data = (await import('brc-shared')).DEFAULT_SETTINGS;
    const adapter = (await import('brc-shared')).FileSnapshotStore;
    const unknown = await import('brc-shared');
  `, ts.ScriptTarget.Latest, true);
  const names = new Set(['FileSnapshotStore', 'createManagedLog']);
  assert.deepEqual(sharedAdapterImports(source, names),
    ['FileSnapshotStore', 'createManagedLog', 'FileSnapshotStore', '*']);
});

test('self construction permits controlled factories and immediate initialization close', () => {
  const source = ts.createSourceFile('sample.ts', `
    class SqliteStore {
      static open() { return new SqliteStore(); }
      static async load() { return new SqliteStore(); }
      static initialize() { const store = new SqliteStore(); store.close(); }
      static other() { return new SqliteStore(); }
      open() { return new SqliteStore(); }
    }
    class OtherStore {
      static open() { return new SqliteStore(); }
      static initialize() { const store = new OtherStore(); sideEffect(); store.close(); }
    }
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(source, 'relay/adapters/sample.ts', 'adapters/sample.ts').sort(), [
    'relay/adapters/sample.ts: nested service construction OtherStore@OtherStore.initialize:store',
    'relay/adapters/sample.ts: nested service construction SqliteStore@OtherStore.open:<return>',
    'relay/adapters/sample.ts: nested service construction SqliteStore@SqliteStore.open:<return>',
    'relay/adapters/sample.ts: nested service construction SqliteStore@SqliteStore.other:<return>',
  ]);
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
    import { FileSnapshotStore, createManagedLog, DEFAULT_SETTINGS } from 'brc-shared';
    import * as shared from 'brc-shared';
    shared.DEFAULT_SETTINGS;
    shared.createManagedLog;
    export { readSettingsText } from 'brc-shared';
    const dynamic = import('brc-shared');
    const required = require('brc-shared');
    import type { DiagnosticLogPort } from 'brc-shared';
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(sharedAdapterImports(source, await sharedAdapterExports()),
    ['FileSnapshotStore', 'createManagedLog', 'createManagedLog', 'readSettingsText', '*', '*']);
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
    'agent/adapters/sample.ts: nested service construction FileSnapshotStore@Adapter.<module>:store',
  ]);
  const other = ts.createSourceFile('sample.ts', `
    import { AsyncLocalStorage } from './external.js';
    class Adapter { context = new AsyncLocalStorage(); }
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ownershipViolations(other, 'agent/adapters/sample.ts', 'adapters/sample.ts'), [
    'agent/adapters/sample.ts: nested service construction AsyncLocalStorage@Adapter.<module>:context',
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
  const violation = 'relay/core/auth/unknown.ts: core imports external dependency fs';
  assert.deepEqual(unexpectedArchitectureViolations([violation], []), [violation]);
});

test('Core boundaries and long-lived object ownership reject new violations per file', async () => {
  const actual = await architectureViolations();
  if (process.env.BRC_ARCHITECTURE_PRINT_BASELINE === '1') {
    process.stdout.write('ARCHITECTURE_BASELINE=' + JSON.stringify(actual) + '\n');
  }
  assert.deepEqual(actual, []);
});
