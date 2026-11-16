import { createInterface } from 'node:readline/promises';
import { cliFailure, cliSuccess, type CliResult } from 'brc-shared';
import { VERSION } from '../core/version.js';
import { clearCredentials, loadCredentials, hasSavedCredentials } from '../adapters/transport/pairing.js';
import type { AgentInvocation } from './parser.js';

const COMMANDS = [
  'connect', 'credentials logout', 'service install', 'service uninstall',
  'config allow-dir', 'help', 'version', 'completion',
];

const HELP = [
  'BRC device Agent',
  'Usage: brc-agent <command> [options]',
  '',
  'Commands:',
  ...COMMANDS.map((command) => '  ' + command),
  '',
  'Global options: --output table|plain|json|yaml, --json, --no-input, --no-color, --offline',
  'Connect: --relay URL, --name NAME, --device-id ID, --token-stdin, --no-browser',
  'Mutations: --preview, --yes, --confirm NAME',
  '',
  'Examples:',
  '  brc-agent connect --relay https://relay.example --no-browser',
  '  brc-agent credentials logout --preview',
  '  brc-agent service install --yes',
  '',
  'Docs: https://github.com/inoceanlee/brc',
].join('\n');

function invalid(message: string, run: string): CliResult<never> {
  return cliFailure({ code: 'INVALID_USAGE', exitCode: 2, message, run, retryable: false });
}

async function confirmChange(message: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(message + ' [y/N] ');
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

function allowsConfirmation(inv: AgentInvocation): boolean {
  return !inv.noInput && !!process.stdin.isTTY && !!process.stderr.isTTY
    && (inv.interactive || (process.env.CI !== 'true' && inv.format !== 'json'));
}

function completion(shell: string): string | null {
  const candidates = COMMANDS.map((item) => item.split(' ')[0]).filter((value, index, values) => values.indexOf(value) === index);
  if (shell === 'powershell') return 'Register-ArgumentCompleter -Native -CommandName brc-agent -ScriptBlock { param($wordToComplete) @(' + candidates.map((item) => JSON.stringify(item)).join(', ') + ') | Where-Object { $_ -like "$wordToComplete*" } }';
  if (shell === 'bash') return '_brc_agent_complete() { COMPREPLY=( $(compgen -W "' + candidates.join(' ') + '" -- "${COMP_WORDS[COMP_CWORD]}") ); }; complete -F _brc_agent_complete brc-agent';
  if (shell === 'zsh') return '#compdef brc-agent\n_arguments \'1: :(' + candidates.join(' ') + ')\'';
  if (shell === 'fish') return candidates.map((item) => 'complete -c brc-agent -f -a ' + item).join('\n');
  return null;
}

export async function runAgentLocalCommand(inv: AgentInvocation): Promise<CliResult> {
  switch (inv.command) {
    case 'help': return cliSuccess(inv.format === 'json' ? { name: 'brc-agent', commands: COMMANDS } : HELP);
    case 'version': return cliSuccess(inv.format === 'json' ? { name: 'brc-agent', version: VERSION } : 'brc-agent ' + VERSION);
    case 'completion': {
      const shell = inv.positionals[0] || 'powershell';
      const script = completion(shell);
      return script === null ? invalid('Shell must be powershell, bash, zsh, or fish.', 'brc-agent completion powershell') : cliSuccess(script);
    }
    case 'credentials logout': {
      const existing = hasSavedCredentials();
      if (inv.preview) return cliSuccess({ action: 'credentials logout', wouldRemove: existing, removed: false });
      if (!existing) return cliSuccess({ action: 'credentials logout', removed: false });
      if (!inv.yes) {
        if (!allowsConfirmation(inv)) {
          return invalid('Credentials deletion requires --yes when non-interactive.', 'brc-agent credentials logout --yes');
        }
        if (!await confirmChange('Remove saved BRC Agent device credentials?')) return cliSuccess({ action: 'credentials logout', removed: false, cancelled: true });
      }
      return cliSuccess({ action: 'credentials logout', removed: clearCredentials() });
    }
    case 'service install':
    case 'service uninstall': {
      const installing = inv.command === 'service install';
      if (inv.preview) return cliSuccess({ action: inv.command, wouldChange: true, changed: false });
      if (!inv.yes && inv.confirm !== 'brc-agent') {
        if (!allowsConfirmation(inv)) {
          return invalid('Service changes require --yes when non-interactive.', 'brc-agent ' + inv.command + ' --yes');
        }
        if (!await confirmChange('Change BRC Agent service registration?')) {
          return cliSuccess({ action: inv.command, changed: false, cancelled: true });
        }
      }
      if (installing && !loadCredentials()) return invalid('Pair the device before installing the service.', 'brc-agent connect --relay URL');
      const { installService, uninstallService } = await import('../adapters/service/service.js');
      const detail = installing
        ? installService(inv.allowDirectories.flatMap((directory) => ['--allow-dir', directory]))
        : uninstallService();
      return cliSuccess({ action: inv.command, changed: true, detail });
    }
    case 'config allow-dir': {
      if (inv.preview) return cliSuccess({ action: inv.command, wouldSet: inv.allowDirectories, changed: false });
      const { configManager } = await import('../adapters/storage/config-manager.js');
      await configManager.setUserSetting('allowedDirectories', inv.allowDirectories);
      return cliSuccess({ action: inv.command, allowedDirectories: inv.allowDirectories, changed: true });
    }
    case 'connect': return invalid('Internal CLI dispatch error.', 'brc-agent connect');
  }
}
