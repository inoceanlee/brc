import type { CliOutputFormat } from 'brc-shared';

export type AgentCommand = 'help' | 'version' | 'completion' | 'connect'
  | 'credentials logout' | 'service install' | 'service uninstall' | 'config allow-dir';

export interface AgentInvocation {
  command: AgentCommand;
  positionals: string[];
  format: CliOutputFormat;
  relay?: string;
  name?: string;
  deviceId?: string;
  allowDirectories: string[];
  tokenStdin: boolean;
  noBrowser: boolean;
  offline: boolean;
  preview: boolean;
  yes: boolean;
  noInput: boolean;
  interactive: boolean;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  timeoutMs?: number;
  noTelemetry: boolean;
  confirm?: string;
}

export class AgentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUsageError';
  }
}

const BOOLEAN_OPTIONS = new Set([
  'help', 'json', 'plain', 'preview', 'yes', 'no-input',
  'interactive', 'quiet', 'verbose', 'debug', 'no-color',
  'offline', 'no-telemetry', 'no-browser', 'token-stdin',
]);
const VALUE_OPTIONS = new Set([
  'output', 'relay', 'name', 'device-id', 'allow-dir', 'timeout', 'confirm', 'brc-managed-id',
]);
const SHORT_OPTIONS: Record<string, string> = {
  h: 'help', n: 'preview', y: 'yes', q: 'quiet', v: 'verbose',
};

function parseTokens(argv: readonly string[]): { flags: Map<string, string[]>; positionals: string[] } {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (positionalOnly || !value.startsWith('-') || value === '-') { positionals.push(value); continue; }
    if (value.startsWith('--')) {
      const equals = value.indexOf('=');
      const name = value.slice(2, equals < 0 ? undefined : equals);
      if (name === 'token') throw new AgentUsageError('Credential values must not be passed as command arguments. Use BRC_TOKEN or --token-stdin.');
      if (name === 'logout' || name === 'install-service' || name === 'uninstall-service') {
        throw new AgentUsageError('Use the credentials or service subcommand instead of legacy mode flags.');
      }
      if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) throw new AgentUsageError('Unknown option: --' + name);
      if (BOOLEAN_OPTIONS.has(name) && equals >= 0) throw new AgentUsageError('Option --' + name + ' does not accept a value.');
      const parameter = BOOLEAN_OPTIONS.has(name) ? 'true' : equals >= 0 ? value.slice(equals + 1) : argv[++i];
      if (!parameter || (VALUE_OPTIONS.has(name) && parameter.startsWith('--'))) throw new AgentUsageError('Option --' + name + ' needs a value.');
      flags.set(name, [...(flags.get(name) ?? []), parameter]);
      continue;
    }
    const letters = value.slice(1);
    for (const letter of letters) {
      const name = SHORT_OPTIONS[letter];
      if (!name) {
        if (letter === 'o') {
          const parameter = letters.length > 1 ? letters.slice(1) : argv[++i];
          if (!parameter) throw new AgentUsageError('Option -o needs a format.');
          flags.set('output', [...(flags.get('output') ?? []), parameter]);
          break;
        }
        throw new AgentUsageError('Unknown option: -' + letter);
      }
      flags.set(name, ['true']);
    }
  }
  return { flags, positionals };
}

export function parseAgentInvocation(argv: readonly string[]): AgentInvocation {
  const { flags, positionals } = parseTokens(argv);
  const has = (key: string) => flags.has(key);
  const one = (key: string) => flags.get(key)?.at(-1);
  const formats = [one('output'), has('json') ? 'json' : undefined, has('plain') ? 'plain' : undefined].filter(Boolean);
  if (formats.some((item) => !['table', 'plain', 'json', 'yaml'].includes(item!))) throw new AgentUsageError('Output format must be table, plain, json, or yaml.');
  if (new Set(formats).size > 1) throw new AgentUsageError('Conflicting output formats.');
  let command: AgentCommand;
  const operands = [...positionals];
  const head = operands.shift();
  if (!head || head === 'help' || has('help')) command = 'help';
  else if (head === 'version') command = 'version';
  else if (head === 'completion') command = 'completion';
  else if (head === 'connect') command = 'connect';
  else if (head === 'credentials' && operands.shift() === 'logout') command = 'credentials logout';
  else if (head === 'service' && ['install', 'uninstall'].includes(operands[0])) command = 'service ' + operands.shift() as AgentCommand;
  else if (head === 'config' && operands.shift() === 'allow-dir') command = 'config allow-dir';
  else throw new AgentUsageError('Unknown command. Run brc-agent help.');
  if (!['completion', 'config allow-dir'].includes(command) && operands.length) throw new AgentUsageError('Unexpected argument: ' + operands[0]);
  const timeout = one('timeout');
  if (timeout && (!/^\\d+$/.test(timeout) || Number(timeout) < 1)) throw new AgentUsageError('--timeout requires a positive number of milliseconds.');
  const allowDirectories = [...(flags.get('allow-dir') ?? []), ...(command === 'config allow-dir' ? operands : [])];
  if (command === 'config allow-dir' && allowDirectories.length === 0) throw new AgentUsageError('Provide a directory to allow.');
  if (has('token-stdin') && command !== 'connect') throw new AgentUsageError('--token-stdin is only valid for connect.');
  if (has('brc-managed-id') && command !== 'connect') throw new AgentUsageError('--brc-managed-id is only valid for connect.');
  return {
    command, positionals: operands, format: (formats[0] ?? 'plain') as CliOutputFormat,
    relay: one('relay'), name: one('name'), deviceId: one('device-id'),
    allowDirectories, tokenStdin: has('token-stdin'), noBrowser: has('no-browser'),
    offline: has('offline'), preview: has('preview'), yes: has('yes'),
    noInput: has('no-input'), interactive: has('interactive'), quiet: has('quiet'),
    verbose: has('verbose'), debug: has('debug'), timeoutMs: timeout ? Number(timeout) : undefined,
    noTelemetry: has('no-telemetry'), confirm: one('confirm'),
  };
}
