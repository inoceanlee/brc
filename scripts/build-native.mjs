import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const crate = path.join(root, 'native', 'brc-process');
const target = 'x86_64-pc-windows-msvc';
const defaultSource = path.join(crate, 'target', target, 'release', 'brc-process.exe');
const defaultDestination = path.join(root, 'packages', 'cli', 'dist', 'native', 'win32-x64', 'brc-process.exe');

export function validatePe(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Native process inspector is not a Windows executable.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Native process inspector must target Windows x64.');
}

/**
 * Cargo tracks Rust module dependencies itself, so the build always delegates
 * incremental decisions to `cargo build`; a new source file can never be
 * skipped by a hand-maintained file list. The artifact is validated and copied
 * only when its contents changed.
 */
export async function buildNative(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? spawnSync;
  const sourcePath = options.sourcePath ?? defaultSource;
  const destinationPath = options.destinationPath ?? defaultDestination;
  if (platform !== 'win32' || arch !== 'x64') return { built: false, copied: false };
  const result = run('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')], {
    cwd: root, stdio: 'inherit', windowsHide: true, shell: false, timeout: 240_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native process inspector build failed.');
  const sourceBinary = await readFile(sourcePath);
  validatePe(sourceBinary);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  let existing;
  try { existing = await readFile(destinationPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const copied = !existing?.equals(sourceBinary);
  if (copied) await copyFile(sourcePath, destinationPath);
  validatePe(await readFile(destinationPath));
  return { built: true, copied };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  await buildNative();
}
