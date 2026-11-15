import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildNative, validatePe } from '../scripts/build-native.mjs';

function fakePe(marker) {
  const bytes = Buffer.alloc(320);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.write(marker, 0xa0, 'ascii');
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-native-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    sourcePath: path.join(root, 'target', 'brc-process.exe'),
    destinationPath: path.join(root, 'dist', 'brc-process.exe'),
  };
}

test('cargo runs on every build so new Rust modules are never skipped', async (t) => {
  const { root, sourcePath, destinationPath } = await fixture(t);
  let cargoRuns = 0;
  const run = () => { cargoRuns += 1; return { status: 0 }; };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, fakePe('first'));
  const first = await buildNative({ platform: 'win32', arch: 'x64', run, sourcePath, destinationPath });
  assert.equal(first.built, true);
  assert.equal(first.copied, true);
  const second = await buildNative({ platform: 'win32', arch: 'x64', run, sourcePath, destinationPath });
  assert.equal(cargoRuns, 2);
  assert.equal(second.copied, false, 'unchanged artifacts must not be copied again');
  assert.ok(root);
});

test('changed native output replaces the packaged binary', async (t) => {
  const { sourcePath, destinationPath } = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, fakePe('first'));
  await buildNative({ platform: 'win32', arch: 'x64', run: () => ({ status: 0 }), sourcePath, destinationPath });
  await writeFile(sourcePath, fakePe('second'));
  const result = await buildNative({ platform: 'win32', arch: 'x64', run: () => ({ status: 0 }), sourcePath, destinationPath });
  assert.equal(result.copied, true);
  assert.equal((await readFile(destinationPath)).toString('ascii', 0xa0, 0xa6), 'second');
});

test('failed cargo builds and non-PE artifacts are rejected', async (t) => {
  const { sourcePath, destinationPath } = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, fakePe('first'));
  await assert.rejects(
    buildNative({ platform: 'win32', arch: 'x64', run: () => ({ status: 1 }), sourcePath, destinationPath }),
    /build failed/,
  );
  await writeFile(sourcePath, Buffer.alloc(300));
  await assert.rejects(
    buildNative({ platform: 'win32', arch: 'x64', run: () => ({ status: 0 }), sourcePath, destinationPath }),
    /not a Windows executable/,
  );
  assert.throws(() => validatePe(Buffer.alloc(10)), /not a Windows executable/);
});

test('non-Windows hosts skip the native inspector build', async () => {
  const result = await buildNative({ platform: 'linux', arch: 'x64', run: () => { throw new Error('must not run'); } });
  assert.deepEqual(result, { built: false, copied: false });
});
