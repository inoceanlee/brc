import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Build-time instrumentation of own TypeScript/JavaScript functions.
 *
 * Each instrumented function calls two optional globals published by the
 * diagnostics runtime. When diagnostics are disabled the probe globals are
 * absent and the instrumented code performs one failed property lookup per
 * call. Original control flow (return, throw, `this`, arguments) is preserved.
 *
 * Generators are reported as unsupported rather than measured incorrectly:
 * suspension time must never be counted as execution time.
 */
export function createInstrumentation(ts, options) {
  const functions = [];
  const skipped = [];
  const files = new Set();
  let counter = 0;

  let sourceFile;
  const relativePath = (fileName) => path.relative(options.rootDir, fileName).split(path.sep).join('/');
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1;

  const textOfName = (name) => {
    if (!name) return undefined;
    if (name.text !== undefined) return String(name.text);
    if (ts.isComputedPropertyName(name)) return '<computed>';
    return undefined;
  };

  const nameOf = (node) => {
    const own = textOfName(node.name);
    if (own) return own;
    const parent = node.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) {
      return textOfName(parent.name) ?? '<anonymous>';
    }
    return '<anonymous>';
  };

  const kindOf = (node) => (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async' : 'sync');

  // Type checking runs before this transform, so the emitted code needs no
  // casts; the probe host is reached through plain JavaScript property access.
  const anyHost = () => ts.factory.createIdentifier('globalThis');

  const probeCall = (name, args) => ts.factory.createCallChain(
    ts.factory.createPropertyAccessExpression(anyHost(), name),
    ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
    undefined,
    args,
  );

  const tokenStatement = (token, id, kind) => ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(token, undefined, undefined, probeCall('__brcDiagBegin', [
        ts.factory.createStringLiteral(id), ts.factory.createStringLiteral(kind),
      ])),
    ], ts.NodeFlags.Const),
  );

  const endStatement = (token) => ts.factory.createExpressionStatement(
    probeCall('__brcDiagEnd', [ts.factory.createIdentifier(token)]),
  );

  const guardedBlock = (statements, token) => [
    tokenStatement(token, currentId, currentKind),
    ts.factory.createTryStatement(
      ts.factory.createBlock(statements, true),
      undefined,
      ts.factory.createBlock([endStatement(token)], true),
    ),
  ];

  let currentId = '';
  let currentKind = 'sync';

  const record = (node, id, kind) => {
    const file = relativePath(sourceFile.fileName);
    functions.push({ id, name: nameOf(node), file, line: lineOf(node), kind });
    files.add(file);
  };

  const nextId = (node) => createHash('sha1')
    .update(`${relativePath(sourceFile.fileName)}:${node.pos}:${nameOf(node)}`)
    .digest('hex')
    .slice(0, 16);

  const wrap = (ts, node, bodyStatements, id, kind, token, update) => {
    const previousId = currentId;
    const previousKind = currentKind;
    currentId = id;
    currentKind = kind;
    const measuredBody = kind === 'async'
      ? [ts.factory.createReturnStatement(ts.factory.createAwaitExpression(
        ts.factory.createCallExpression(ts.factory.createParenthesizedExpression(
          ts.factory.createArrowFunction(
            [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
            undefined,
            [],
            undefined,
            ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            ts.factory.createBlock(bodyStatements, true),
          ),
        ), undefined, []),
      ))]
      : bodyStatements;
    const statements = guardedBlock(measuredBody, token);
    currentId = previousId;
    currentKind = previousKind;
    return update(statements);
  };

  const instrument = (node) => {
    if (node.pos < 0 || node.end < 0) return node;
    if (node.asteriskToken) {
      skipped.push({ file: relativePath(sourceFile.fileName), line: lineOf(node), name: nameOf(node), reason: 'generator' });
      return node;
    }
    if (!node.body) {
      skipped.push({ file: relativePath(sourceFile.fileName), line: lineOf(node), name: nameOf(node), reason: 'no-body' });
      return node;
    }
    const id = nextId(node);
    const kind = kindOf(node);
    const token = `__brcDiag${(counter += 1)}`;
    record(node, id, kind);

    if (ts.isArrowFunction(node)) {
      const statements = ts.isBlock(node.body) ? node.body.statements : [ts.factory.createReturnStatement(node.body)];
      return wrap(ts, node, statements, id, kind, token, (wrapped) => ts.factory.updateArrowFunction(
        node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken,
        ts.factory.createBlock(wrapped, true),
      ));
    }
    const body = node.body.statements;
    if (ts.isConstructorDeclaration(node)) {
      const superIndex = body.findIndex((statement) => ts.isExpressionStatement(statement)
        && ts.isCallExpression(statement.expression) && statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
      const head = superIndex >= 0 ? body.slice(0, superIndex + 1) : [];
      const rest = superIndex >= 0 ? body.slice(superIndex + 1) : body;
      return wrap(ts, node, rest, id, kind, token, (statements) => ts.factory.updateConstructorDeclaration(
        node, node.modifiers, node.parameters, ts.factory.createBlock([...head, ...statements], true),
      ));
    }
    return wrap(ts, node, body, id, kind, token, (statements) => {
      const nextBody = ts.factory.createBlock(statements, true);
      if (ts.isFunctionDeclaration(node)) {
        return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, nextBody);
      }
      if (ts.isFunctionExpression(node)) {
        return ts.factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, nextBody);
      }
      if (ts.isMethodDeclaration(node)) {
        return ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, nextBody);
      }
      if (ts.isGetAccessorDeclaration(node)) {
        return ts.factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.type, nextBody);
      }
      if (ts.isSetAccessorDeclaration(node)) {
        return ts.factory.updateSetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, nextBody);
      }
      throw new Error(`Unsupported function-like node: ${ts.SyntaxKind[node.kind]}`);
    });
  };

  let transformContext;

  const visit = (node) => {
    const visited = ts.visitEachChild(node, visit, transformContext);
    if (ts.isFunctionDeclaration(visited) || ts.isFunctionExpression(visited) || ts.isArrowFunction(visited)
      || ts.isMethodDeclaration(visited) || ts.isConstructorDeclaration(visited)
      || ts.isGetAccessorDeclaration(visited) || ts.isSetAccessorDeclaration(visited)) {
      return instrument(visited);
    }
    return visited;
  };

  const context = {};

  const exclude = options.exclude ?? [];

  return {
    transformer(context) {
      return (file) => {
        const normalized = file.fileName.split(path.sep).join('/');
        if (file.isDeclarationFile || exclude.some((pattern) => normalized.includes(pattern))) {
          return file;
        }
        sourceFile = file;
        return ts.visitNode(file, visit);
      };
    },
    report() {
      const unique = new Map(functions.map((item) => [item.id, item]));
      return {
        schema: 1,
        package: options.packageName,
        generatedAt: new Date().toISOString(),
        instrumented: unique.size,
        files: files.size,
        functions: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)),
        skipped: skipped.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
      };
    },
  };
}
