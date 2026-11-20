import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { ARCHITECTURE_BASELINE, compareWithBaseline } from './brc-architecture-baseline.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cliSrc = path.join(repository, 'packages', 'cli', 'src');
const FORBIDDEN_IN_CORE = ['node:fs', 'node:net', 'node:http', 'node:child_process', 'node:dgram'];
const PACKAGE_NAMES = ['cli', 'relay', 'agent', 'shared'];
const EXTERNAL_IO = /^(?:node:)?(?:fs(?:\/promises)?|net|http|https|child_process|dgram|os|worker_threads|tty|readline|console|stream|process|path)(?:\/.*)?$/;
const EXTERNAL_SDK = /^(?:express|ws|better-sqlite3|sqlite3|proper-lockfile|@modelcontextprotocol\/|@sqlite\/)/;
const SERVICE_TYPES = /(?:Manager|Store|Storage|Lock|Service|Server|Sampler|Session|Controller|Provider|Tracker|History|Hub|Transport|Client|Dispatcher|Recorder|Logger|Handler|Timing|DiagnosticLog)$/;
const ENTRY_FILES = new Set(['cli.ts', 'main.ts']);

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
  if (methodName !== 'initialize' || !ts.isVariableDeclaration(node.parent) || !ts.isIdentifier(node.parent.name)) return false;
  const statement = node.parent.parent.parent;
  if (!ts.isVariableStatement(statement) || node.parent.parent.declarations.length !== 1 || !ts.isBlock(statement.parent)) return false;
  const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
  if (!next || !ts.isExpressionStatement(next) || !ts.isCallExpression(next.expression)
    || next.expression.arguments.length !== 0 || !ts.isPropertyAccessExpression(next.expression.expression)) return false;
  const access = next.expression.expression;
  return ts.isIdentifier(access.expression) && access.expression.text === node.parent.name.text && access.name.text === 'close';
}

function isDataInterface(statement) {
  if (!ts.isInterfaceDeclaration(statement)) return false;
  const aliases = new Map(statement.getSourceFile().statements.filter(ts.isTypeAliasDeclaration)
    .map((item) => [item.name.text, item.type]));
  function callable(node, seen = new Set()) {
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node) || ts.isCallSignatureDeclaration(node)) return true;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && aliases.has(node.typeName.text)) {
      if (seen.has(node.typeName.text)) return false;
      if (callable(aliases.get(node.typeName.text), new Set(seen).add(node.typeName.text))) return true;
    }
    return Boolean(ts.forEachChild(node, (child) => callable(child, seen)));
  }
  return statement.members.every((member) => ts.isPropertySignature(member) && member.type && !callable(member.type));
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

function isRequestScopedMcpResource(className, relative) {
  if (className === 'StreamableHTTPServerTransport') return true;
  if (className === 'Server' && relative === 'adapters/http/mcp/server.ts') return true;
  return false;
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
  const logFactories = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'brc-shared'
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const item of statement.importClause.namedBindings.elements) {
        if ((item.propertyName ?? item.name).text === 'createManagedLog') logFactories.add(item.name.text);
      }
    }
  }
  function visit(node) {
    if (ts.isNewExpression(node)) {
      const className = serviceConstructionName(node);
      if (className && !isControlledSelfConstruction(node) && !isRequestScopedMcpResource(className, relative)) {
        let parent = node.parent;
        let retained = /(?:Store|Storage|Lock|Timing|DiagnosticLog)$/.test(className);
        if (!/(?:Session|Transport)$/.test(className)
          && (ts.isReturnStatement(node.parent) || (ts.isArrowFunction(node.parent) && node.parent.body === node))) retained = true;
        while (parent && parent !== source) {
          if (ts.isPropertyDeclaration(parent)) retained = true;
          if (ts.isBinaryExpression(parent)
            && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) retained = true;
          if (ts.isVariableDeclaration(parent) && parent.initializer === node) retained = true;
          if (ts.isFunctionLike(parent)) break;
          parent = parent.parent;
        }
        if (retained && !inCore(relative)) {
          violations.push(prefix + ': nested service construction ' + className + '@' + constructionIdentity(node, source));
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && logFactories.has(node.expression.text)) {
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
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'brc-shared' && statement.importClause && !statement.importClause.isTypeOnly) {
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && adapterNames.has(name)) found.push(name);
        }
      }
    }
  }
  return found;
}

async function architectureViolations() {
  const violations = [];
  const adapterNames = await sharedAdapterExports();
  for (const pkg of PACKAGE_NAMES) {
    const root = path.join(repository, 'packages', pkg, 'src');
    const dataTypes = new Set();
    const files = await sourceFiles(root);
    const sources = new Map();
    for (const filename of files) {
      sources.set(path.resolve(filename), ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true));
    }
    for (const filename of files) {
      if (!inCore(path.relative(root, filename).replaceAll('\\', '/'))) continue;
      const core = sources.get(path.resolve(filename));
      for (const statement of core.statements) {
        if (isDataInterface(statement)) dataTypes.add(statement.name.text);
      }
    }
    for (const filename of files) {
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      const source = sources.get(path.resolve(filename));
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
  const shared = path.join(repository, 'packages', 'shared', 'src');
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

test('architecture gate detects Agent core path imports', async () => {
  const violations = await architectureViolations();
  assert.ok(
    violations.includes('agent/core/ui/file-preview/shared/preview-file-types.ts: core imports external dependency path'),
    'Agent core path import must be reported',
  );
});

test('CLI cleanup adapter receives its process manager from the entrypoint', async () => {
  const violations = await architectureViolations();
  assert.equal(
    violations.some((entry) => entry.startsWith('cli/adapters/storage/cleanup.ts: nested service construction ProcessManager@')),
    false,
  );
  const source = await readFile(path.join(cliSrc, 'adapters/storage/cleanup.ts'), 'utf8');
  assert.match(source, /createProcessManager/);
  assert.doesNotMatch(source, /new ProcessManager/);
  const entry = await readFile(path.join(cliSrc, 'cli.ts'), 'utf8');
  assert.match(entry, /new ProcessManager/);
});

test('architecture baseline matches current violations without stale entries', async () => {
  const actual = await architectureViolations();
  assert.deepEqual(compareWithBaseline(actual, ARCHITECTURE_BASELINE), { newViolations: [], staleBaseline: [] });
});

test('architecture baseline rejects violations outside it and stale entries', () => {
  assert.deepEqual(
    compareWithBaseline(
      ['cli/a.ts: rule one', 'relay/b.ts: rule two'],
      new Set(['relay/b.ts: rule two', 'agent/c.ts: rule three']),
    ),
    { newViolations: ['cli/a.ts: rule one'], staleBaseline: ['agent/c.ts: rule three'] },
  );
});

test('architecture baseline entries are precise file and rule strings', () => {
  for (const entry of ARCHITECTURE_BASELINE) {
    assert.match(entry, /^(?:cli|relay|agent|shared)\/[^\s:]+(?:\/[^\s:]+)*: .+$/, entry);
    assert.doesNotMatch(entry, /\*/, entry);
  }
});
