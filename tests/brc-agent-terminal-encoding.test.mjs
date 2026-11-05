import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('Windows shell probe streams Chinese stdin/stdout/stderr and preserves command exit codes', { skip: process.platform !== 'win32' }, async () => {
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
      command: 'set /p inputText= & cmd /v:on /c "echo BRC-IN-!inputText!" & echo BRC-OUT-中文 & echo BRC-ERR-中文 1>&2 & exit /b 23',
      input: '中文',
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
    assert.equal((text.match(/BRC-IN-中文/g) ?? []).length, 1, `${shellCase.executable}: stdin round-trip failed: ${JSON.stringify(text)}`);
    assert.equal((text.match(/BRC-OUT-中文/g) ?? []).length, 1, `${shellCase.executable}: stdout encoding failed: ${JSON.stringify(text)}`);
    assert.equal((text.match(/BRC-ERR-中文/g) ?? []).length, 1, `${shellCase.executable}: stderr encoding failed: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /BRC_PROBE_/);
    assert.equal(completed.exitCode, 23);
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

test('PowerShell probe keeps input, output, and native pipe encodings independent', () => {
  assert.deepEqual(parseShellEncodingInfo('powershell', 'in=gbk;out=utf-8;pipe=gbk;cp=936'), info);
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

