import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextFileHandler } from '../packages/agent/dist/adapters/filesystem/files/text.js';

async function withFile(content, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-text-test-'));
  const file = path.join(dir, 'sample.txt');
  try {
    await writeFile(file, content);
    await run(file, new TextFileHandler());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('reads UTF-8 CRLF pages and a final line without a newline', async () => {
  await withFile('first\r\nsecond\r\nlast', async (file, handler) => {
    assert.equal((await handler.read(file, { offset: 1, length: 2, includeStatusMessage: false })).content, 'second\nlast');
    assert.equal((await handler.read(file, { offset: -2, includeStatusMessage: false })).content, 'second\nlast');
    assert.equal((await handler.getInfo(file)).metadata.lineCount, 3);
  });
});

test('reads UTF-16LE BOM with pagination and tail', async () => {
  await withFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('一\r\n二\r\n三', 'utf16le')]), async (file, handler) => {
    assert.equal((await handler.read(file, { offset: 1, length: 1, includeStatusMessage: false })).content, '二');
    assert.equal((await handler.read(file, { offset: -2, includeStatusMessage: false })).content, '二\n三');
    assert.equal((await handler.getInfo(file)).metadata.lineCount, 3);
  });
});

test('preserves the UTF-8 BOM in the first line', async () => {
  await withFile(Buffer.from('\ufefffirst\nsecond', 'utf8'), async (file, handler) => {
    assert.equal((await handler.read(file, { length: 1, includeStatusMessage: false })).content, '\ufefffirst');
  });
});

test('uses the default read limit unless a caller supplies a length', async () => {
  await withFile(Array.from({ length: 1002 }, (_, i) => `line ${i}`).join('\n'), async (file, handler) => {
    const defaultPage = (await handler.read(file, { includeStatusMessage: false })).content.split('\n');
    assert.equal(defaultPage.length, 1000);
    assert.equal(defaultPage[999], 'line 999');
    assert.equal((await handler.read(file, { length: 2, includeStatusMessage: false })).content, 'line 0\nline 1');
  });
});

test('applies the configured read limit when length is omitted', async () => {
  const { handleReadFile } = await import('../packages/agent/dist/adapters/mcp/handlers/filesystem-handlers.js');
  await withFile('one\ntwo\nthree', async (file, handler) => {
    const dependencies = {
      configManager: { getConfig: async () => ({ fileReadLineLimit: 2, allowedDirectories: [] }) },
      capture: async () => {},
      fileHandlers: { getFileHandler: async () => handler },
    };
    const result = await handleReadFile({ path: file }, dependencies);
    assert.match(result.content[0].text, /\n\none\ntwo$/);
    const explicit = await handleReadFile({ path: file, length: 1 }, dependencies);
    assert.match(explicit.content[0].text, /\n\none$/);
  });
});

test('reads long lines and reports the requested page', async () => {
  const long = 'x'.repeat(100000);
  await withFile(`one\n${long}\nthree`, async (file, handler) => {
    assert.equal((await handler.read(file, { offset: 1, length: 1 })).content, `[Reading 1 lines from line 1 (total: 3 lines, 1 remaining)]\n\n${long}`);
  });
});

test('reads the end of a large file without losing the last line', async () => {
  await withFile(`${'x'.repeat(11 * 1024 * 1024)}\nalpha\nbeta\n`, async (file, handler) => {
    assert.equal((await handler.read(file, { offset: -2, includeStatusMessage: false })).content, 'alpha\nbeta');
  });
});

test('bounds reverse reads with and without a trailing newline', async () => {
  for (const suffix of ['\nalpha\nbeta', '\nalpha\nbeta\n']) {
    await withFile(`${'x'.repeat(11 * 1024 * 1024)}${suffix}`, async (file, handler) => {
      const originalOpen = fs.open;
      let bytesRead = 0;
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          bytesRead += result.bytesRead;
          return result;
        };
        return handle;
      };
      try {
        assert.equal((await handler.read(file, { offset: -2, includeStatusMessage: false })).content, 'alpha\nbeta');
        assert.ok(bytesRead <= 8194, `read ${bytesRead} bytes`);
      } finally {
        fs.open = originalOpen;
      }
    });
  }
});

test('appends and rewrites without changing write semantics', async () => {
  await withFile('old', async (file, handler) => {
    await handler.write(file, '+new', 'append');
    assert.equal(await readFile(file, 'utf8'), 'old+new');
    await handler.write(file, 'replacement');
    assert.equal(await readFile(file, 'utf8'), 'replacement');
  });
});

test('file transfer receive sessions are isolated between instances', async () => {
  const { prepareFileReceive, receiveFileTransfer } = await import('../packages/agent/dist/adapters/filesystem/file-transfer.js');
  const firstKeys = new Map();
  const secondKeys = new Map();
  const first = prepareFileReceive(firstKeys);
  const second = prepareFileReceive(secondKeys);

  assert.equal(firstKeys.has(first.receiveId), true);
  assert.equal(secondKeys.has(second.receiveId), true);
  assert.equal(firstKeys.has(second.receiveId), false);
  assert.equal(secondKeys.has(first.receiveId), false);

  await assert.rejects(
    receiveFileTransfer({}, secondKeys, first.receiveId, '', ''),
    /Receive session is missing or expired/,
  );
  assert.equal(firstKeys.has(first.receiveId), true);
  assert.equal(secondKeys.has(second.receiveId), true);
  firstKeys.clear();
  secondKeys.clear();
});
