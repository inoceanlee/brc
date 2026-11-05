import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32') throw new Error('This experiment requires Windows');
const work = mkdtempSync(path.join(os.tmpdir(), 'brc-cmd-gh-probe-'));
const reportPath = path.join(process.env.RUNNER_TEMP || work, 'brc-cmd-encoding-report.json');
const results = { platform: process.platform, node: process.version, work, cases: [], observations: {}, benchmarks: {}, errors: [] };
const unicode = '中文-日本語-🙂';

writeFileSync(path.join(work, '中文 文件.txt'), 'FILE-中文-日本語-🙂\r\n', 'utf8');
writeFileSync(path.join(work, 'external-utf8.mjs'),
  "process.stdout.write('EXT-中文-日本語-🙂\\n');process.stderr.write('EXTERR-中文\\n');process.exitCode=23;\n", 'utf8');
writeFileSync(path.join(work, 'external-gbk.mjs'),
  'process.stdout.write(Buffer.from([0x47,0x42,0x4b,0x2d,0xd6,0xd0,0xce,0xc4,0x0a]));\n', 'utf8');
writeFileSync(path.join(work, 'utf8-script.cmd'), '@echo off\r\necho BATCH-中文-日本語-🙂\r\n', 'utf8');

function command(command, { codePage, input = '', env = {}, timeout = 8000 } = {}) {
  const prefix = codePage ? 'chcp ' + codePage + ' >nul & ' : '';
  const script = prefix + 'chcp 65001 >nul & cmd /d /c !BRC_TEST_COMMAND!';
  const result = spawnSync('cmd.exe', ['/d', '/v:on', '/c', script], {
    cwd: work, env: { ...process.env, ...env, BRC_TEST_COMMAND: command },
    input: Buffer.from(input, 'utf8'), windowsHide: true, windowsVerbatimArguments: true,
    timeout, maxBuffer: 1024 * 1024
  });
  return { exitCode: result.status, stdout: result.stdout?.toString('utf8') || '',
    stderr: result.stderr?.toString('utf8') || '', stdoutHex: result.stdout?.toString('hex').slice(0, 200),
    error: result.error?.message || null };
}
async function check(name, run) {
  try {
    const details = await run();
    results.cases.push({ name, pass: true, ...details });
    console.log('PASS', name);
  } catch (error) {
    results.cases.push({ name, pass: false, error: error.stack || String(error) });
    results.errors.push(name + ': ' + error.message);
    console.error('FAIL', name, error.message);
  }
}

const base = spawnSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true });
results.observations.hiddenCmdInitialCodePageOutput = base.stdout.toString('hex').slice(0, 120);
results.observations.hiddenCmdInitialCodePage = base.stdout.toString('latin1').match(/\b(437|936|65001)\b/)?.[1] ?? 'other';
console.log('Hidden CMD initial codepage:', results.observations.hiddenCmdInitialCodePage);

for (const cp of [undefined, 437, 936, 65001]) {
  await check('unicode stdout/stderr & exit code, initial CP=' + (cp ?? 'system'), () => {
    const r = command('echo OUT-' + unicode + ' & echo ERR-' + unicode + ' 1>&2 & exit /b 23', { codePage: cp });
    assert.equal(r.exitCode, 23, JSON.stringify(r));
    assert.match(r.stdout, /OUT-中文-日本語-🙂/);
    assert.match(r.stderr, /ERR-中文-日本語-🙂/);
    return { codePage: cp ?? 'system', stdout: r.stdout.trim(), stderr: r.stderr.trim(), exitCode: r.exitCode };
  });
}
await check('interactive stdin round-trip', () => {
  const r = command('set /p X= & cmd /v:on /c "echo IN-!X!" & echo OUT-中文', { input: unicode + '\r\n' });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /IN-中文-日本語-🙂/);
  return { stdout: r.stdout.trim() };
});
await check('pipes and conditions', () => {
  const r = command('echo PIPE-中文 | findstr PIPE && echo SUCCESS-日本語-🙂');
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /PIPE-中文/);
  assert.match(r.stdout, /SUCCESS-日本語-🙂/);
  return { stdout: r.stdout.trim() };
});
await check('redirection and unicode file names', () => {
  const r = command('echo REDIR-' + unicode + '> "generated output.txt" & type "generated output.txt" & type "中文 文件.txt"');
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /REDIR-中文-日本語-🙂/);
  assert.match(r.stdout, /FILE-中文-日本語-🙂/);
  assert.match(readFileSync(path.join(work, 'generated output.txt'), 'utf8'), /REDIR-中文-日本語-🙂/);
  return { stdout: r.stdout.trim() };
});
await check('UTF-8 batch script', () => {
  const r = command('call "utf8-script.cmd"');
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /BATCH-中文-日本語-🙂/);
  return { stdout: r.stdout.trim() };
});
await check('external UTF-8 program', () => {
  const r = command('node.exe "external-utf8.mjs"');
  assert.equal(r.exitCode, 23, JSON.stringify(r));
  assert.match(r.stdout, /EXT-中文-日本語-🙂/);
  assert.match(r.stderr, /EXTERR-中文/);
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), exitCode: r.exitCode };
});
await check('quotes and percent expansion', () => {
  const r = command('echo "QUOTED-中文-🙂" & echo PERCENT-%BRC_TEST_VALUE%', { env: { BRC_TEST_VALUE: 'VALUE-日本語' } });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /QUOTED-中文-🙂/);
  assert.match(r.stdout, /PERCENT-VALUE-日本語/);
  return { stdout: r.stdout.trim() };
});
await check('literal exclamation and conditional OR', () => {
  const r = command('echo LITERAL!TAG! & cmd /d /c exit /b 1 || echo FALLBACK-中文');
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.match(r.stdout, /LITERAL!TAG!/);
  assert.match(r.stdout, /FALLBACK-中文/);
  return { stdout: r.stdout.trim() };
});
await check('shell handshake with phased unicode input', () => new Promise((resolve, reject) => {
  const childCommand = 'set /p X= & cmd /v:on /c "echo IN-!X!" & echo OUT-中文 & echo ERR-中文 1>&2 & exit /b 23';
  const probe = 'chcp 65001 >nul & for /f "tokens=2 delims=:" %A in (\'chcp\') do @echo BRC_MARK^|cp=%A & set /p "_BRC_READY=" && cmd /d /c !BRC_TEST_COMMAND!';
  const child = spawn('cmd.exe', ['/d', '/v:on', '/c', probe], {
    cwd: work, env: { ...process.env, BRC_TEST_COMMAND: childCommand },
    windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '', sent = false, settled = false;
  const timeout = setTimeout(() => finish(new Error('handshake timed out')), 8000);
  function finish(error, code) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) { child.kill(); reject(error); return; }
    try {
      assert.equal(code, 23, JSON.stringify({ code, stdout, stderr }));
      assert.match(stdout, /BRC_MARK\|cp=\s*65001/);
      assert.match(stdout, /IN-中文-日本語-🙂/);
      assert.match(stdout, /OUT-中文/);
      assert.match(stderr, /ERR-中文/);
      resolve({ stdout: stdout.trim().slice(0, 250), stderr: stderr.trim(), exitCode: code });
    } catch (e) { reject(e); }
  }
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
    if (!sent && stdout.includes('BRC_MARK|cp=')) {
      sent = true;
      child.stdin.write('Y\r\n', 'utf8');
      setTimeout(() => child.stdin.write(unicode + '\r\n', 'utf8'), 80);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('error', finish);
  child.on('close', code => finish(null, code));
}));
const gbk = command('node.exe "external-gbk.mjs"');
results.observations.legacyGbkExternalOutput = { stdoutAsUtf8: gbk.stdout, rawHex: gbk.stdoutHex,
  note: 'Legacy external program intentionally emits GBK. UTF-8 decoder cannot recover Unicode.' };
console.log('OBSERVE legacy GBK output bytes:', gbk.stdoutHex);

for (const count of [512, 2048, 3072, 4096]) {
  const sample = '中'.repeat(count);
  const r = command('echo ' + sample, { timeout: 5000 });
  results.observations['longCommand_' + count] = {
    passed: r.exitCode === 0 && r.stdout.trim() === sample,
    status: r.exitCode, chars: r.stdout.trim().length, error: r.error, stderr: r.stderr.slice(0, 120)
  };
  console.log('OBSERVE command length', count, JSON.stringify(results.observations['longCommand_' + count]));
}

function sampleTime(mode) {
  const times = [];
  for (let i = 0; i < 14; i++) {
    const start = performance.now();
    const r = mode === 'native'
      ? spawnSync('cmd.exe', ['/d', '/c', 'echo BENCH'], { windowsHide: true, timeout: 4000 })
      : command('echo BENCH', { timeout: 4000 });
    if (r.status !== undefined ? r.status !== 0 : r.exitCode !== 0) throw new Error('benchmark command failed');
    if (i > 1) times.push(performance.now() - start);
  }
  times.sort((a,b)=>a-b);
  return { medianMs: +times[Math.floor(times.length/2)].toFixed(2), p95Ms: +times[Math.ceil(times.length * 0.95)-1].toFixed(2) };
}
await check('benchmark both command paths', () => {
  results.benchmarks.native = sampleTime('native');
  results.benchmarks.wrapper = sampleTime('wrapper');
  return { native: results.benchmarks.native, wrapper: results.benchmarks.wrapper };
});

results.summary = { passed: results.cases.filter(x=>x.pass).length, total: results.cases.length, failures: results.errors.length };
writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
console.log('RESULT', JSON.stringify(results.summary), 'REPORT', reportPath);
if (results.errors.length > 0) process.exitCode = 1;
