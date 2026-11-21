import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('pdf image extraction receives the configured pdf log port', async () => {
  const extract = await source('../packages/agent/src/adapters/filesystem/pdf/extract-images.ts');
  assert.doesNotMatch(extract, /textLogToStderr/);
  assert.match(extract, /log: TextLogPort/);
  const pdf2md = await source('../packages/agent/src/adapters/filesystem/pdf/lib/pdf2md.ts');
  assert.match(pdf2md, /extractImagesFromPdf\(pdfBuffer, pageNumberMap, \{ format: 'webp', quality: 85 \}, log\)/);
  const markdown = await source('../packages/agent/src/adapters/filesystem/pdf/markdown.ts');
  assert.match(markdown, /pdf2md\(new Uint8Array\(data\), pageNumbers, pdfLogPort\)/);
});
