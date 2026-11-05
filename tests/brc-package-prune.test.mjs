import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installLockedRuntimeDependencies } from '../scripts/release-dependencies.mjs';
import { spawnSync } from 'node:child_process';
import { pruneStagedDependencies } from '../scripts/release-prune.mjs';

async function createFile(root, relativePath, content = 'x') {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
  return filename;
}

async function createWorkspace(root) {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lock-fixture', private: true }));
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  await createFile(root, 'packages/cli/package.json', JSON.stringify({
    name: 'lock-fixture-cli',
    version: '1.0.0',
    dependencies: { 'lock-fixture-shared': 'workspace:*' },
  }));
  await createFile(root, 'packages/shared/package.json', JSON.stringify({
    name: 'lock-fixture-shared',
    version: '1.0.0',
  }));
  const generated = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
}

function createPnpmRunner(isolationRoot) {
  return (args, cwd) => {
    const result = spawnSync('pnpm', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        PNPM_CONFIG_STORE_DIR: path.join(isolationRoot, 'store'),
        PNPM_CONFIG_STATE_DIR: path.join(isolationRoot, 'state'),
        PNPM_CONFIG_CACHE_DIR: path.join(isolationRoot, 'cache'),
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `pnpm exited ${result.status}`);
  };
}

test('locked dependency installation rejects manifest changes against workspace lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lock-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createWorkspace(root);
  const output = path.join(root, 'stage');
  const work = path.join(root, 'temporary');
  const runPnpm = createPnpmRunner(work);

  await installLockedRuntimeDependencies({
    workspaceRoot: root,
    stageDir: output,
    workDir: work,
    sourcePackages: ['cli', 'shared'],
    runPnpm,
  });

  assert.equal((await stat(path.join(output, 'node_modules'))).isDirectory(), true);
  await rm(path.join(output, 'node_modules'), { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));
  manifest.dependencies['lock-fixture-shared'] = 'workspace:^';
  await writeFile(path.join(root, 'packages', 'cli', 'package.json'), JSON.stringify(manifest));

  await assert.rejects(
    installLockedRuntimeDependencies({
      workspaceRoot: root,
      stageDir: output,
      workDir: path.join(root, 'temporary-mismatch'),
      sourcePackages: ['cli', 'shared'],
      runPnpm: createPnpmRunner(path.join(root, 'temporary-mismatch')),
    }),
    /lockfile|frozen/i,
  );
});

test('pruning removes non-runtime dependency files and preserves runtime assets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-prune-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const packageRoot = path.join(stage, 'node_modules', 'fixture');
  await createFile(packageRoot, 'package.json', JSON.stringify({
    exports: {
      '.': { import: './index.js', types: './types.d.ts' },
      './features/*': './features/*.ts',
      './tests/runtime': './tests/runtime.js',
    },
  }));
  await createFile(packageRoot, 'index.js', '//# sourceMappingURL=index.js.map\n');
  await createFile(packageRoot, 'index.js.map', '{}');
  await createFile(packageRoot, 'lib/unreferenced.js.map', '{}');
  await createFile(packageRoot, 'types.d.ts', 'export type Value = string;');
  await createFile(packageRoot, 'features/item.ts', 'export const item = 1;');
  await createFile(packageRoot, 'src/internal.ts', 'export const unused = 1;');
  await createFile(packageRoot, 'LICENSE', 'license text');
  await createFile(packageRoot, 'NOTICE.txt', 'notice text');
  await createFile(packageRoot, 'README.md', 'dependency documentation');
  await createFile(packageRoot, 'docs/usage.md', 'dependency documentation');
  await createFile(packageRoot, 'lib/doc/workbook.js', 'runtime ExcelJS workbook');
  await createFile(packageRoot, 'lib/docs/template.md', 'nested runtime documentation asset');
  await createFile(packageRoot, 'lib/tests/driver.js', 'nested runtime test driver');
  await createFile(packageRoot, 'lib/example/transform.js', 'nested runtime utility');
  await createFile(packageRoot, 'tests/case.js', 'test code');
  await createFile(packageRoot, 'tests/runtime.js', 'export const runtime = true;');
  await createFile(packageRoot, 'examples/demo.js', 'example code');
  await createFile(packageRoot, 'assets/image.png', 'image bytes');
  await createFile(packageRoot, 'assets/document.pdf', 'pdf bytes');
  await createFile(packageRoot, 'assets/spreadsheet.xlsx', 'office bytes');
  await createFile(packageRoot, 'assets/runtime-template.md', '# runtime markdown');

  const result = await pruneStagedDependencies(stage);

  assert.equal(result.filesRemoved, 6);
  assert.ok(result.bytesRemoved > 0);
  assert.ok(result.byCategory.sourceMaps.files >= 1);
  assert.ok(result.byCategory.typescript.files >= 1);
  assert.ok(result.byCategory.tests.files >= 1);
  assert.ok(result.byCategory.examples.files >= 1);
  await assert.rejects(stat(path.join(packageRoot, 'lib/unreferenced.js.map')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(packageRoot, 'src/internal.ts')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(packageRoot, 'README.md')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(packageRoot, 'docs/usage.md')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(packageRoot, 'tests/case.js')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(packageRoot, 'examples/demo.js')), { code: 'ENOENT' });
  for (const relativePath of [
    'index.js.map', 'types.d.ts', 'features/item.ts', 'tests/runtime.js', 'LICENSE', 'NOTICE.txt',
    'assets/image.png', 'assets/document.pdf', 'assets/spreadsheet.xlsx', 'assets/runtime-template.md',
    'lib/doc/workbook.js', 'lib/docs/template.md', 'lib/tests/driver.js', 'lib/example/transform.js',
  ]) {
    await stat(path.join(packageRoot, relativePath));
  }
  assert.equal(await readFile(path.join(packageRoot, 'assets/runtime-template.md'), 'utf8'), '# runtime markdown');
});

test('pruning never follows dependency symlinks outside the stage directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-prune-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const external = path.join(root, 'external');
  await createFile(external, 'tests/keep.js', 'external data');
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  await symlink(external, path.join(stage, 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  const result = await pruneStagedDependencies(stage);

  assert.equal(result.filesRemoved, 0);
  assert.equal(await readFile(path.join(external, 'tests/keep.js'), 'utf8'), 'external data');
});
