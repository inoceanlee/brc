/**
 * Register the agent to start at login without admin rights. Windows uses Task Scheduler with a hidden wscript launcher. Linux uses a systemd user unit with an enable-linger hint. macOS uses a launchd LaunchAgent plist. The service runs the CLI with saved credentials, so pair first.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveAgentPaths } from '../storage/agent-paths.js';

const NAME = 'brc-agent';
const cliPath = () => fileURLToPath(new URL('../../cli.js', import.meta.url));
const home = () => path.dirname(resolveAgentPaths().credentialsFile);
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true }).toString();

export function ownsWindowsTask(xml: string, launcher: string): boolean {
  const command = xml.match(/<Command>\s*([^<]*?)\s*<\/Command>/i)?.[1]?.trim() ?? '';
  const argumentsText = xml.match(/<Arguments>\s*([^<]*?)\s*<\/Arguments>/i)?.[1]?.replace(/&quot;/g, '"')?.trim() ?? '';
  const resolved = argumentsText.replace(/^"|"$/g, '');
  return /^(?:.*[\\/])?wscript(?:\.exe)?$/i.test(command) && resolved.toLowerCase() === launcher.toLowerCase();
}

function readWindowsTask(): string | null {
  try { return run('schtasks', ['/Query', '/TN', NAME, '/XML']); }
  catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}

function verifyManagedFile(file: string, marker: string): void {
  if (!readFileSync(file, 'utf8').includes(marker)) throw Object.assign(new Error('Existing service registration is not owned by BRC Agent.'), { exitCode: 5 });
}

export function installService(extraArgs: string[]): string {
  mkdirSync(home(), { recursive: true });
  const node = process.execPath;
  const args = [cliPath(), 'connect', '--no-browser', ...extraArgs];
  const logFile = path.join(home(), 'agent.log');

  if (process.platform === 'win32') {
    const cmdFile = path.join(home(), 'start-agent.cmd');
    const vbs = path.join(home(), 'start-agent.vbs');
    const existing = readWindowsTask();
    if (existing !== null) {
      if (!existsSync(vbs) || !ownsWindowsTask(existing, vbs)) throw Object.assign(new Error('An unrelated or unverified scheduled task already uses the BRC Agent name.'), { exitCode: 5 });
      return `Task Scheduler task "${NAME}" already installed.`;
    }
    if (existsSync(vbs) || existsSync(cmdFile)) throw Object.assign(new Error('Unverified Agent startup scripts exist without a matching scheduled task.'), { exitCode: 5 });
    writeFileSync(cmdFile, `@echo off\r\ncd /d "${home()}"\r\n"${node}" ${args.map((a) => `"${a}"`).join(' ')} >> "${logFile}" 2>&1\r\n`);
    writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "cmd /c ""${cmdFile}""", 0, False\r\n`);
    run('schtasks', ['/Create', '/TN', NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `wscript.exe "${vbs}"`]);
    run('schtasks', ['/Run', '/TN', NAME]);
    return `Installed Task Scheduler task "${NAME}" (runs at logon, hidden). Log: ${logFile}\nManage: schtasks /Query /TN ${NAME} | schtasks /End /TN ${NAME}`;
  }
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const unit = path.join(dir, `${NAME}.service`);
    if (existsSync(unit)) {
      verifyManagedFile(unit, 'Description=Better Remote Commander (BRC) device agent');
      return `BRC Agent systemd service already installed: ${unit}.`;
    }
    writeFileSync(unit, `[Unit]\nDescription=Better Remote Commander (BRC) device agent\nAfter=network-online.target\n\n[Service]\nExecStart=${node} ${args.join(' ')}\nRestart=always\nRestartSec=5\nEnvironment=BRC_DATA_ROOT=${resolveAgentPaths().root}\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
    return `Installed systemd user unit ${unit}.\nTo keep it running when logged out: sudo loginctl enable-linger ${os.userInfo().username}\nLogs: journalctl --user -u ${NAME} -f`;
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, `dev.brc.${NAME}.plist`);
    const xmlArgs = [node, ...args].map((a) => `    <string>${a}</string>`).join('\n');
    if (existsSync(plist)) {
      verifyManagedFile(plist, `<string>dev.brc.${NAME}</string>`);
      return `BRC Agent launchd service already installed: ${plist}.`;
    }
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.brc.${NAME}</string>\n  <key>ProgramArguments</key><array>\n${xmlArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${logFile}</string>\n  <key>StandardErrorPath</key><string>${logFile}</string>\n  <key>EnvironmentVariables</key><dict><key>BRC_DATA_ROOT</key><string>${resolveAgentPaths().root}</string></dict>\n</dict></plist>\n`);
    try { run('launchctl', ['unload', plist]); } catch {}
    run('launchctl', ['load', '-w', plist]);
    return `Installed LaunchAgent ${plist}. Log: ${logFile}`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}

export function uninstallService(): string {
  if (process.platform === 'win32') {
    const vbs = path.join(home(), 'start-agent.vbs');
    const existing = readWindowsTask();
    if (existing === null) return `BRC Agent task "${NAME}" is not installed.`;
    if (!existsSync(vbs) || !ownsWindowsTask(existing, vbs)) throw Object.assign(new Error('Refusing to remove a scheduled task without verified BRC Agent ownership.'), { exitCode: 5 });
    try { run('schtasks', ['/End', '/TN', NAME]); } catch {}
    run('schtasks', ['/Delete', '/F', '/TN', NAME]);
    for (const f of ['start-agent.vbs', 'start-agent.cmd']) { const p = path.join(home(), f); if (existsSync(p)) unlinkSync(p); }
    return `Removed Task Scheduler task "${NAME}". If an Agent remains running, stop its specific PID.`;
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
    if (!existsSync(unit)) return `BRC Agent service ${unit} is not installed.`;
    verifyManagedFile(unit, 'Description=Better Remote Commander (BRC) device agent');
    run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]);
    unlinkSync(unit);
    run('systemctl', ['--user', 'daemon-reload']);
    return `Removed systemd user unit ${NAME}.service.`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `dev.brc.${NAME}.plist`);
    if (!existsSync(plist)) return `BRC Agent launchd service ${plist} is not installed.`;
    verifyManagedFile(plist, `<string>dev.brc.${NAME}</string>`);
    try { run('launchctl', ['unload', plist]); } catch {}
    unlinkSync(plist);
    return `Removed LaunchAgent ${plist}.`;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}
