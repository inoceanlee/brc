import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getSimilarityRatio, recursiveFuzzyIndexOf, runFuzzySearch } from '../dist/core/tools/fuzzySearchCore.js';

const agentRoot = fileURLToPath(new URL('../', import.meta.url));

function referenceDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function referenceSimilarity(a, b) {
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0 ? 1 : 1 - referenceDistance(a, b) / maxLength;
}

test('core tools import no third-party or external SDK modules', async () => {
  const directory = path.join(agentRoot, 'src', 'core', 'tools');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 2, 'expected the core tools source files');
  for (const name of files) {
    const source = await readFile(path.join(directory, name), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const external = specifiers.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'));
    assert.deepEqual(external, [], `${name} must not import external modules`);
  }
});

test('similarity ratio matches the Levenshtein definition including edge cases', () => {
  const pairs = [
    ['', ''], ['', 'abc'], ['abc', ''], ['kitten', 'sitting'], ['abc', 'abc'],
    ['The quick brown fox', 'quik brown'], ['é中文abc', 'é中文abd'],
    ['a'.repeat(40) + 'b', 'a'.repeat(40) + 'c'], ['flaw', 'lawn'], ['gumbo', 'gambol'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(getSimilarityRatio(a, b), referenceSimilarity(a, b), `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  let seed = 20261121;
  const alphabet = 'abcXYZ0123 é中';
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let index = 0; index < 2000; index++) {
    const a = Array.from({ length: next() % 70 }, () => alphabet[next() % alphabet.length]).join('');
    const b = Array.from({ length: next() % 70 }, () => alphabet[next() % alphabet.length]).join('');
    assert.equal(getSimilarityRatio(a, b), referenceSimilarity(a, b), `random pair ${index}`);
  }
});

test('fuzzy search results stay identical to the captured baseline', () => {
  const cases = [
    ['The quick brown fox jumps over the lazy dog', 'quik brown', { start: 4, end: 15, value: 'quick brown', distance: 1 }],
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaab', { start: 35, end: 39, value: 'aaaa', distance: 1 }],
    ['prefix-MIDDLE-suffix', 'MIDDLE', { start: 7, end: 13, value: 'MIDDLE', distance: 0 }],
    ['hello world hello world', 'world', { start: 6, end: 11, value: 'world', distance: 0 }],
    ['', 'x', { start: 0, end: 0, value: '', distance: 1 }],
    ['abc', '', { start: 0, end: 0, value: '', distance: 0 }],
    ['single', 'single', { start: 0, end: 6, value: 'single', distance: 0 }],
  ];
  for (const [text, query, expected] of cases) {
    assert.deepEqual(runFuzzySearch(text, query).result, expected, `runFuzzySearch ${JSON.stringify(query)}`);
    assert.deepEqual(recursiveFuzzyIndexOf(text, query), expected, `recursiveFuzzyIndexOf ${JSON.stringify(query)}`);
  }
});

test('tool argument schemas keep parsing and rejection behavior after relocation', async () => {
  const schemas = await import('../dist/adapters/mcp/schemas.js');
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  assert.deepEqual(schemas.GetConfigArgsSchema.parse({}), {});
  assert.deepEqual(schemas.GetConfigArgsSchema.parse({ origin: 'ui' }), { origin: 'ui' });
  assert.equal(schemas.GetConfigArgsSchema.safeParse({ origin: 'bad' }).success, false);
  assert.deepEqual(schemas.SetConfigValueArgsSchema.parse({ key: 'k', value: true }), { key: 'k', value: true });
  assert.equal(schemas.SetConfigValueArgsSchema.safeParse({ key: 'k', value: {} }).success, false);
  assert.deepEqual(schemas.ReadFileArgsSchema.parse({ path: '/x' }), { path: '/x', isUrl: false, offset: 0 });
  assert.deepEqual(schemas.PrepareFileTransferArgsSchema.parse({}), { ttlSeconds: 3600 });
  assert.equal(schemas.PrepareFileTransferArgsSchema.safeParse({ ttlSeconds: 30 }).success, false);
  assert.equal(schemas.EditBlockArgsSchema.safeParse({ file_path: '/x' }).success, false);
  assert.equal(schemas.EditBlockArgsSchema.safeParse({ file_path: '/x', old_string: 'a', new_string: 'b' }).success, true);
  assert.equal(schemas.EditBlockArgsSchema.safeParse({ file_path: '/x', range: '1:2', content: 'x' }).success, true);
  assert.deepEqual(
    schemas.WritePdfArgsSchema.parse({ path: '/x.pdf', content: '[{"type":"delete","pageIndexes":[0]}]' }),
    { path: '/x.pdf', content: [{ type: 'delete', pageIndexes: [0] }] },
  );
  assert.deepEqual(zodToJsonSchema(schemas.GetConfigArgsSchema), {
    type: 'object',
    properties: { origin: { type: 'string', enum: ['ui', 'llm'] } },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  });
});
