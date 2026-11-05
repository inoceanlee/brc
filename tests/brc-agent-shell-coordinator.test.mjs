import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const coordinatorPath = process.env.BRC_SHELL_COORDINATOR_MODULE;
const coordinatorUrl = coordinatorPath
  ? (coordinatorPath.startsWith('file:') ? coordinatorPath : pathToFileURL(path.resolve(coordinatorPath)).href)
  : new URL('../packages/agent/dist/core/shell-coordinator.js', import.meta.url).href;

const {
  ShellEncodingCoordinator,
  DefaultShellEncodingSession,
  ShellEncodingSessionImpl,
  ShellProbeFeedResult,
} = await import(coordinatorUrl);

test('ShellEncodingCoordinator resolves probe shells correctly across platforms', () => {
  // Windows platform
  const winPwsh = new ShellEncodingCoordinator('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(winPwsh.resolveProbeShell(), 'powershell');

  const winPwshCore = new ShellEncodingCoordinator('win32', 'pwsh.exe');
  assert.equal(winPwshCore.resolveProbeShell(), 'powershell');

  const winCmd = new ShellEncodingCoordinator('win32', 'cmd.exe');
  assert.equal(winCmd.resolveProbeShell(), 'cmd');

  const winDefault = new ShellEncodingCoordinator('win32', undefined);
  assert.equal(winDefault.resolveProbeShell(), 'cmd');

  const winBash = new ShellEncodingCoordinator('win32', 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(winBash.resolveProbeShell(), 'posix');

  const winCustom = new ShellEncodingCoordinator('win32', 'custom-tool.exe');
  assert.equal(winCustom.resolveProbeShell(), null);

  // POSIX platforms (linux, darwin)
  const linuxBash = new ShellEncodingCoordinator('linux', '/bin/bash');
  assert.equal(linuxBash.resolveProbeShell(), 'posix');

  const linuxZsh = new ShellEncodingCoordinator('linux', '/usr/bin/zsh');
  assert.equal(linuxZsh.resolveProbeShell(), 'posix');

  const darwinDefault = new ShellEncodingCoordinator('darwin', undefined);
  assert.equal(darwinDefault.resolveProbeShell(), 'posix');

  const linuxPwsh = new ShellEncodingCoordinator('linux', '/usr/bin/pwsh');
  assert.equal(linuxPwsh.resolveProbeShell(), 'powershell');
});

test('CMD session transports Unicode commands through an isolated environment variable', () => {
  const coordinator = new ShellEncodingCoordinator('win32', 'cmd.exe');
  const command = 'echo BRC-中文-日本語-🙂';
  const session = coordinator.createSession(command);
  assert.equal(session.command, command);
  assert.match(session.wrappedCommand, /chcp 65001 >nul/);
  assert.match(session.wrappedCommand, /cmd \/d \/c !BRC_CMD_/);
  assert.doesNotMatch(session.wrappedCommand, /中文|日本語|🙂/);
  const entries = Object.entries(session.commandEnvironment);
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /^BRC_CMD_BRC_PROBE_[0-9a-f]{32}$/);
  assert.equal(entries[0][1], command);
  session.dispose();
});

test('CMD session rejects commands too large for reliable CMD parsing', () => {
  const coordinator = new ShellEncodingCoordinator('win32', 'cmd.exe');
  assert.throws(() => coordinator.createSession('echo ' + '中'.repeat(3072)), /CMD command exceeds/);
  assert.throws(() => coordinator.createSession('echo one\necho two'), /single-line/);
  assert.throws(() => coordinator.createSession('echo a\0b'), /NUL/);
  const session = coordinator.createSession('echo ' + '中'.repeat(512));
  session.dispose();
  const posix = new ShellEncodingCoordinator('linux', '/bin/bash').createSession('echo one\necho two');
  assert.match(posix.wrappedCommand, /echo two/);
  posix.dispose();
});

test('ShellEncodingCoordinator creates session with wrapped command and marker', () => {
  const coordinator = new ShellEncodingCoordinator('linux', '/bin/bash');
  const session = coordinator.createSession('echo hello', 5000);
  assert.equal(session.command, 'echo hello');
  assert.equal(session.probeRequired, true);
  assert.equal(session.isReady, false);
  assert.match(session.marker, /^BRC_PROBE_[0-9a-f]{32}$/);
  assert.match(session.wrappedCommand, /locale charmap/);
  assert.match(session.wrappedCommand, /echo hello/);
  session.dispose();
});

test('ShellEncodingSession intercepts probe stdout, instantiates iconv decoders, and provides handshake', () => {
  const session = new DefaultShellEncodingSession('echo test', 5000, 'posix', 'BRC_PROBE_TEST');
  assert.equal(session.isReady, false);

  let readyFired = false;
  let detectedInfo = null;
  let receivedHandshake = null;
  session.onReady((info, handshake) => {
    readyFired = true;
    detectedInfo = info;
    receivedHandshake = handshake;
  });

  // Early stderr is buffered while probe is pending
  const earlyErr = session.feedStderr(Buffer.from([0xD6, 0xD0])); // '中' in GBK
  assert.equal(earlyErr, '');

  // Incomplete stdout is buffered
  const pendingRes = session.feedStdout(Buffer.from('pre BRC_PROBE_TEST|charmap='));
  assert.equal(pendingRes.ready, false);
  assert.equal(pendingRes.text, '');

  // Completing the probe with GBK locale report
  const completeRes = session.feedStdout(Buffer.from('GBK;lang=zh_CN.GBK\npost\n'));
  assert.equal(completeRes.ready, true);
  assert.equal(session.isReady, true);
  assert.equal(readyFired, true);
  assert.equal(detectedInfo.consoleOutput, 'gbk');
  assert.equal(session.inputEncoding, 'gbk');
  assert.equal(session.outputEncoding, 'gbk');

  // Verify handshake buffer
  assert.ok(receivedHandshake);
  assert.deepEqual(receivedHandshake, Buffer.from('Y\n', 'ascii'));

  // Verify early stdout prefix/trailing decoded
  assert.equal(completeRes.text, 'pre post\n');

  // Verify buffered early stderr was drained through GBK decoder
  assert.equal(completeRes.earlyStderr, '中');

  // Subsequent stdout feeds directly through GBK decoder
  const chineseStdout = session.feedStdout(Buffer.from([0xCE, 0xC4])); // '文' in GBK
  assert.equal(chineseStdout.text, '文');
  assert.equal(chineseStdout.ready, true);

  // Subsequent stderr feeds directly through GBK decoder
  const chineseStderr = session.feedStderr(Buffer.from([0xCE, 0xC4])); // '文' in GBK
  assert.equal(chineseStderr, '文');

  // Test encodeInput uses detected input encoding
  assert.deepEqual(session.encodeInput('中文'), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]));

  session.dispose();
});

test('ShellEncodingSession supports bypass when probe is not required', () => {
  const session = new DefaultShellEncodingSession('echo raw', 5000, null);
  assert.equal(session.probeRequired, false);
  assert.equal(session.isReady, true);
  assert.equal(session.wrappedCommand, 'echo raw');

  const out = session.feedStdout(Buffer.from('hello world'));
  assert.equal(out.text, 'hello world');
  assert.equal(out.ready, true);

  const err = session.feedStderr(Buffer.from('stderr raw'));
  assert.equal(err, 'stderr raw');

  session.dispose();
});

test('ShellEncodingSession handles timeout and triggers onTimeout', async () => {
  const session = new DefaultShellEncodingSession('echo timeout', 50, 'posix', 'BRC_PROBE_TMO');
  let timedOut = false;
  let timeoutErr = null;

  session.onTimeout((err) => {
    timedOut = true;
    timeoutErr = err;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(timedOut, true);
  assert.match(timeoutErr.message, /timed out/);

  session.dispose();
});
