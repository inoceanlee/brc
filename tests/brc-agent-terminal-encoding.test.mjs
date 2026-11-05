import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.BRC_TERMINAL_ENCODING_MODULE;
const moduleUrl = modulePath
  ? (modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href)
  : new URL('../packages/agent/dist/core/terminal-encoding.js', import.meta.url).href;
const {
  ShellEncodingProbe,
  createShellEncodingDecoder,
  encodeShellInput,
  parseShellEncodingInfo,
  parsePosixLocaleReport,
  getPosixShellProbeCommand,
  buildPosixShellProbeCommand,
  normalizeEncoding,
} = await import(moduleUrl);
const terminalManagerUrl = new URL('../packages/agent/dist/core/terminal-manager.js', import.meta.url).href;

test('Windows shell probe preserves supported stdin/stdout/stderr encodings and exit codes', { skip: process.platform !== 'win32' }, async () => {
  const { TerminalManager } = await import(terminalManagerUrl);
  const manager = new TerminalManager();
  const cases = [
    {
      executable: 'powershell.exe',
      command: '[Console]::Out.WriteLine("BRC-READY"); $value = [Console]::In.ReadLine(); [Console]::Out.WriteLine("BRC-IN-" + $value); [Console]::Out.WriteLine("BRC-OUT-中文"); [Console]::Error.WriteLine("BRC-ERR-中文"); exit 23',
      input: '中文',
    },
    {
      executable: 'pwsh.exe',
      command: '[Console]::Out.WriteLine("BRC-READY"); $value = [Console]::In.ReadLine(); [Console]::Out.WriteLine("BRC-IN-" + $value); [Console]::Out.WriteLine("BRC-OUT-中文"); [Console]::Error.WriteLine("BRC-ERR-中文"); exit 23',
      input: '中文',
    },
    {
      executable: 'cmd.exe',
      command: 'set /p inputText= & cmd /v:on /c "echo BRC-IN-!inputText!" & echo BRC-OUT-中文-日本語-🙂 & echo BRC-ERR-中文-日本語-🙂 1>&2 & exit /b 23',
      input: '中文-日本語-🙂',
    },
  ];

  for (const shellCase of cases) {
    const found = spawnSync('where.exe', [shellCase.executable], { encoding: 'utf8' });
    if (found.status !== 0) continue;
    const shellPath = found.stdout.split(/\r?\n/, 1)[0].trim();
    const result = await manager.executeCommand(shellCase.command, 100, shellPath);
    assert.equal(result.isBlocked, true, `${shellCase.executable} should wait for stdin`);
    assert.equal(manager.sendInputToProcess(result.pid, shellCase.input), true);
    const deadline = Date.now() + 5000;
    let completed;
    while (Date.now() < deadline) {
      completed = manager.readOutputPaginated(result.pid, 0, 1000);
      if (completed?.isComplete) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (completed?.isComplete === false) manager.forceTerminate(result.pid);

    assert.equal(completed?.isComplete, true, `${shellCase.executable} should complete after stdin`);
    const text = completed.lines.join('\n');
    for (const stream of ['IN', 'OUT', 'ERR']) {
      const expected = `BRC-${stream}-${shellCase.input}`;
      assert.equal(text.split(expected).length - 1, 1, `${shellCase.executable}: ${stream} round-trip failed: ${JSON.stringify(text)}`);
    }
    assert.doesNotMatch(text, /BRC_PROBE_/);
    assert.equal(completed.exitCode, 23);
  }
});

test('Windows CMD handles UTF-8 files, native streams, Unicode paths, and command operators', { skip: process.platform !== 'win32' }, async () => {
  const { TerminalManager } = await import(terminalManagerUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brc-cmd-unicode-'));
  const inputPath = path.join(directory, '中文 文件.txt');
  const scriptPath = path.join(directory, 'external.mjs');
  fs.writeFileSync(inputPath, 'BRC-FILE-中文-日本語-🙂\n', 'utf8');
  fs.writeFileSync(scriptPath, 'process.stdout.write("BRC-NODE-中文-日本語-🙂\\n"); process.stderr.write("BRC-STDERR-中文\\n"); process.exitCode=23;', 'utf8');
  const manager = new TerminalManager();
  const command = `type "${inputPath}" & echo BRC-PIPE-中文 | findstr PIPE & node.exe "${scriptPath}"`;
  let pid = -1;
  try {
    const started = await manager.executeCommand(command, 100, 'cmd.exe');
    pid = started.pid;
    assert.ok(pid > 0, JSON.stringify(started));
    let completed;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      completed = manager.readOutputPaginated(pid, 0, 1000);
      if (completed?.isComplete) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(completed?.isComplete, true, 'CMD session should complete');
    const output = completed.lines.join('\n');
    assert.match(output, /BRC-FILE-中文-日本語-🙂/);
    assert.match(output, /BRC-PIPE-中文/);
    assert.match(output, /BRC-NODE-中文-日本語-🙂/);
    assert.match(output, /BRC-STDERR-中文/);
    assert.equal(completed.exitCode, 23);
  } finally {
    if (pid > 0 && !manager.readOutputPaginated(pid, 0, 1)?.isComplete) manager.forceTerminate(pid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('completed Windows shell waits for the stdout pipe to drain', { skip: process.platform !== 'win32' }, async () => {
  const { TerminalManager } = await import(terminalManagerUrl);
  const manager = new TerminalManager();
  const command = '[Console]::Out.WriteLine("BRC-READY"); [Console]::In.ReadLine() | Out-Null; [Console]::Out.WriteLine("BRC-FLUSHED")';
  const started = await manager.executeCommand(command, 100, 'powershell.exe');
  assert.equal(started.isBlocked, true);
  const child = manager.getSession(started.pid)?.process;
  assert.ok(child, 'waiting shell must remain active');
  child.stdout.pause();
  child.once('exit', () => setTimeout(() => child.stdout.resume(), 50));
  assert.equal(manager.sendInputToProcess(started.pid, 'continue'), true);

  let completed;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    completed = manager.readOutputPaginated(started.pid, 0, 1000);
    if (completed?.isComplete) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completed?.isComplete, true);
  assert.match(completed.lines.join('\n'), /BRC-FLUSHED/);
});

const info = { consoleInput: 'gbk', consoleOutput: 'utf-8', nativePipe: 'gbk', codePage: 936 };

test('PowerShell child upgrades legacy console encoding for Unicode pipes', { skip: process.platform !== 'win32' }, async () => {
  const { getShellProbeCommand } = await import(moduleUrl);
  const command = '[Console]::Out.WriteLine("BRC-READY"); $v=[Console]::In.ReadLine(); [Console]::Out.WriteLine("BRC-IN-"+$v); [Console]::Out.WriteLine("BRC-OUT-中文"); [Console]::Error.WriteLine("BRC-ERR-中文")';
  const wrapped = getShellProbeCommand('powershell', 'BRC_CP437', command);
  const legacy = '[Console]::InputEncoding=[Text.Encoding]::GetEncoding(437);[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(437);$OutputEncoding=[Text.Encoding]::GetEncoding(437)';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', legacy + ';' + wrapped], {
    input: ['Y', '中文', ''].join(String.fromCharCode(10)), encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC_CP437\|in=utf-8;out=utf-8;pipe=utf-8;cp=65001/);
  assert.match(result.stdout, /BRC-IN-中文/);
  assert.match(result.stdout, /BRC-OUT-中文/);
  assert.match(result.stderr, /BRC-ERR-中文/);
});

test('PowerShell probe keeps input, output, and native pipe encodings independent', () => {
  assert.deepEqual(parseShellEncodingInfo('powershell', 'in=gbk;out=utf-8;pipe=gbk;cp=936'), info);
});

test('CMD probe accepts only a validated command environment variable', async () => {
  const { getShellProbeCommand } = await import(moduleUrl);
  assert.throws(() => getShellProbeCommand('cmd', 'BRC_PROBE_TEST', 'echo 中文'), /requires a valid/);
  assert.throws(() => getShellProbeCommand('cmd', 'BRC_PROBE_TEST', 'echo 中文', 'BAD-NAME'), /requires a valid/);
  const wrapped = getShellProbeCommand('cmd', 'BRC_PROBE_TEST', 'echo 中文', 'BRC_CMD_TEST');
  assert.match(wrapped, /chcp 65001/);
  assert.match(wrapped, /cmd \/d \/c !BRC_CMD_TEST!/);
  assert.doesNotMatch(wrapped, /中文/);
});

test('CMD probe rejects unsupported code pages', () => {
  assert.throws(() => parseShellEncodingInfo('cmd', 'cp=99999'), /unsupported code page/);
});

test('shell output decoder preserves Chinese characters across byte chunks', () => {
  const decoder = createShellEncodingDecoder('gbk');
  const encoded = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]);
  assert.equal(decoder.write(encoded.subarray(0, 1)), '');
  assert.equal(decoder.write(encoded.subarray(1, 3)), '中');
  assert.equal(decoder.end(encoded.subarray(3)), '文');
});

test('shell input encoder uses detected console input encoding', () => {
  assert.deepEqual(encodeShellInput('中文', info.consoleInput), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]));
});

test('probe parser detects a marker split across chunks and preserves surrounding bytes', () => {
  const probe = new ShellEncodingProbe('BRC_PROBE_123');
  assert.deepEqual(probe.push(Buffer.from('before BRC_PROBE_')), { state: 'pending' });
  const result = probe.push(Buffer.from('123|in=gbk;out=utf-8;pipe=gbk;cp=936\nafter'));
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.info, info);
  assert.equal(new TextDecoder().decode(result.stdout), 'before ');
  assert.equal(new TextDecoder().decode(result.trailing), 'after');
});

test('probe parser rejects output beyond its configured byte limit', () => {
  const probe = new ShellEncodingProbe('BRC_PROBE_123', 8);
  assert.throws(() => probe.push(Buffer.from('012345678')), /probe output exceeded/);
});
test('CMD probe parses chcp reports and preserves bytes around a split marker', () => {
  const probe = new ShellEncodingProbe('BRC_PROBE_123', 64 * 1024, 'cmd');
  assert.deepEqual(probe.push(Buffer.from('before BRC_PROBE_123|cp=')), { state: 'pending' });
  const result = probe.push(Buffer.from('936\r\nafter'));
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.info, { consoleInput: 'gbk', consoleOutput: 'gbk', nativePipe: 'gbk', codePage: 936 });
  assert.equal(result.stdout.toString('ascii'), 'before ');
  assert.equal(result.trailing.toString('ascii'), 'after');
});

test('shell decoder flushes final bytes passed to end', () => {
  const decoder = createShellEncodingDecoder('gbk');
  assert.equal(decoder.write(Buffer.from([0xD6, 0xD0, 0xCE])), '中');
  assert.equal(decoder.end(Buffer.from([0xC4])), '文');
});

test('parsePosixLocaleReport normalizes UTF-8, GBK, GB2312, ISO-8859-1, EUC-JP, and Shift-JIS', () => {
  assert.deepEqual(parsePosixLocaleReport('charmap=UTF-8;lang=en_US.UTF-8'), {
    consoleInput: 'utf-8', consoleOutput: 'utf-8', nativePipe: 'utf-8', codePage: 65001,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=GBK;lang=zh_CN.GBK'), {
    consoleInput: 'gbk', consoleOutput: 'gbk', nativePipe: 'gbk', codePage: 936,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=GB2312;lang=zh_CN.GB2312'), {
    consoleInput: 'gbk', consoleOutput: 'gbk', nativePipe: 'gbk', codePage: 936,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=ISO-8859-1;lang=en_US.ISO-8859-1'), {
    consoleInput: 'iso-8859-1', consoleOutput: 'iso-8859-1', nativePipe: 'iso-8859-1', codePage: 28591,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=EUC-JP;lang=ja_JP.ujis'), {
    consoleInput: 'euc-jp', consoleOutput: 'euc-jp', nativePipe: 'euc-jp', codePage: 20932,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=Shift_JIS;lang=ja_JP.SJIS'), {
    consoleInput: 'shift_jis', consoleOutput: 'shift_jis', nativePipe: 'shift_jis', codePage: 932,
  });
});

test('parsePosixLocaleReport prefers lang codeset when charmap is ascii fallback', () => {
  assert.deepEqual(parsePosixLocaleReport('charmap=ANSI_X3.4-1968;lang=en_US.UTF-8'), {
    consoleInput: 'utf-8', consoleOutput: 'utf-8', nativePipe: 'utf-8', codePage: 65001,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=;lang=zh_CN.gbk'), {
    consoleInput: 'gbk', consoleOutput: 'gbk', nativePipe: 'gbk', codePage: 936,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=ANSI_X3.4-1968;lang=C'), {
    consoleInput: 'ascii', consoleOutput: 'ascii', nativePipe: 'ascii', codePage: 20127,
  });
  assert.deepEqual(parsePosixLocaleReport('charmap=;lang='), {
    consoleInput: 'utf-8', consoleOutput: 'utf-8', nativePipe: 'utf-8', codePage: 65001,
  });
});

test('parsePosixLocaleReport throws on invalid probe report or unsupported encoding', () => {
  assert.throws(() => parsePosixLocaleReport('foo=bar'), /invalid POSIX locale probe report/);
  assert.throws(() => parsePosixLocaleReport('charmap=invalid_encoding_xyz;lang='), /unsupported shell encoding/);
});

test('POSIX shell probe command builder injects locale charmap, LC_ALL/LANG and read handshake', () => {
  const cmd = getPosixShellProbeCommand('BRC_PROBE_123', 'echo hello');
  assert.match(cmd, /locale charmap/);
  assert.match(cmd, /LC_ALL/);
  assert.match(cmd, /BRC_PROBE_123\|charmap=%s;lang=%s/);
  assert.match(cmd, /read -r _BRC_READY/);
  assert.match(cmd, /echo hello/);
  assert.equal(buildPosixShellProbeCommand('BRC_PROBE_123', 'echo hello'), cmd);
});

test('ShellEncodingProbe handles POSIX shell probe outputs', () => {
  const probe = new ShellEncodingProbe('BRC_PROBE_POSIX', 64 * 1024, 'posix');
  const result = probe.push(Buffer.from('pre BRC_PROBE_POSIX|charmap=UTF-8;lang=en_US.UTF-8\npost'));
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.info, { consoleInput: 'utf-8', consoleOutput: 'utf-8', nativePipe: 'utf-8', codePage: 65001 });
  assert.equal(result.stdout.toString('ascii'), 'pre ');
  assert.equal(result.trailing.toString('ascii'), 'post');
});

