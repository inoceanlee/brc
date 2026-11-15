import { isBrcSettingKey, parseSettingArgument } from '../config/settings.js';

export type CliCommandName =
  | 'help' | 'version' | 'setup' | 'start' | 'stop' | 'restart' | 'status'
  | 'logs' | 'config' | 'update' | 'uninstall' | 'clean' | 'diagnose';

export type DiagnoseTarget = 'startup' | 'functions' | 'resources';

export interface CliLogComponents {
  readonly components: readonly string[];
}

export const LOG_COMPONENTS = ['relay', 'agent', 'traefik', 'cli'] as const;
export const DIAGNOSE_TARGETS: readonly DiagnoseTarget[] = ['startup', 'functions', 'resources'];

export class UsageError extends Error {
  readonly exitCode = 2;
}

export class AuthError extends Error {
  readonly exitCode = 3;
}

export class NotFoundError extends Error {
  readonly exitCode = 4;
}

export class ConflictError extends Error {
  readonly exitCode = 5;
}

export class CancelledError extends Error {
  readonly exitCode = 130;
}

export interface ParsedCommand {
  name: CliCommandName;
  args: string[];
  json: boolean;
  timing: boolean;
  quiet: boolean;
  verbose: boolean;
  noInput: boolean;
  includeStatus: boolean;
  diagnose?: DiagnoseTarget;
  logComponent?: (typeof LOG_COMPONENTS)[number];
}

interface CommandSpec {
  name: CliCommandName;
  usage: string;
  summary: string;
  examples: readonly string[];
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: 'help',
    usage: 'brc help [command]',
    summary: 'Show command help.',
    examples: ['brc help', 'brc help start'],
  },
  {
    name: 'version',
    usage: 'brc version [--json]',
    summary: 'Print the installed BRC version.',
    examples: ['brc version', 'brc version --json'],
  },
  {
    name: 'setup',
    usage: 'brc setup',
    summary: 'Initialize local configuration and Traefik.',
    examples: ['brc setup'],
  },
  {
    name: 'start',
    usage: 'brc start [--timing]',
    summary: 'Start Relay, Traefik, and Agent.',
    examples: ['brc start', 'brc start --timing'],
  },
  {
    name: 'stop',
    usage: 'brc stop',
    summary: 'Stop the managed services.',
    examples: ['brc stop'],
  },
  {
    name: 'restart',
    usage: 'brc restart',
    summary: 'Restart the managed services.',
    examples: ['brc restart'],
  },
  {
    name: 'status',
    usage: 'brc status [--json]',
    summary: 'Show managed service status.',
    examples: ['brc status', 'brc status --json'],
  },
  {
    name: 'logs',
    usage: 'brc logs [relay|agent|traefik|cli]',
    summary: 'Show recent logs for one component.',
    examples: ['brc logs', 'brc logs cli'],
  },
  {
    name: 'config',
    usage: 'brc config <show|get|set|apply|path> [key] [value] [--json]',
    summary: 'Show or update local settings.',
    examples: ['brc config show', 'brc config show --json', 'brc config set proxy.rate.average 20'],
  },
  {
    name: 'update',
    usage: 'brc update traefik',
    summary: 'Update the managed Traefik binary.',
    examples: ['brc update traefik'],
  },
  {
    name: 'clean',
    usage: 'brc clean',
    summary: 'Run safe cleanup of expired BRC data.',
    examples: ['brc clean'],
  },
  {
    name: 'uninstall',
    usage: 'brc uninstall --yes',
    summary: 'Stop services and remove BRC data and the global package.',
    examples: ['brc uninstall --yes'],
  },
  {
    name: 'diagnose',
    usage: 'brc diagnose <startup|functions|resources> [--json]',
    summary: 'Show startup timing, function timings, or resource samples.',
    examples: ['brc diagnose startup', 'brc diagnose functions --json', 'brc diagnose resources'],
  },
];

const UNINSTALL_NOTE = [
  'pnpm remove -g @inoceanlee/brc removes only the package and keeps BRC data.',
  'Run brc uninstall --yes to stop services and remove BRC data and the global package.',
];

function specFor(name: CliCommandName): CommandSpec {
  const spec = COMMAND_SPECS.find((item) => item.name === name);
  if (!spec) throw new UsageError(`Unknown command: ${name}. Run brc help.`);
  return spec;
}

export function helpText(command?: CliCommandName): string {
  if (command) {
    const spec = specFor(command);
    const lines = [spec.usage, '', spec.summary];
    if (spec.examples.length) {
      lines.push('', 'Examples:');
      for (const example of spec.examples) lines.push(`  ${example}`);
    }
    return lines.join('\n');
  }
  const lines = ['BRC unified CLI', '', 'Usage: brc <command>', '', 'Commands:'];
  for (const spec of COMMAND_SPECS) {
    lines.push(`  ${spec.usage.replace(/^brc /, 'brc ').padEnd(46)} ${spec.summary}`);
  }
  lines.push('', 'Global flags: --quiet, --verbose, --no-input', '', ...UNINSTALL_NOTE);
  return lines.join('\n');
}

function stripGlobalFlags(argv: string[]): { args: string[]; quiet: boolean; verbose: boolean; noInput: boolean } {
  const args: string[] = [];
  let quiet = false;
  let verbose = false;
  let noInput = false;
  for (const value of argv) {
    if (value === '--quiet') { quiet = true; continue; }
    if (value === '--verbose') { verbose = true; continue; }
    if (value === '--no-input') { noInput = true; continue; }
    args.push(value);
  }
  return { args, quiet, verbose, noInput };
}

function flagContext(argv: string[]) {
  const { args, quiet, verbose, noInput } = stripGlobalFlags(argv);
  return { args, quiet, verbose, noInput };
}

function parseConfigArgs(args: string[]): { args: string[]; json: boolean } {
  const json = args.includes('--json');
  const rest = args.filter((value) => value !== '--json');
  const [subcommand, key, value] = rest;
  const validKey = key !== undefined && isBrcSettingKey(key);
  const shapeValid = (
    ((subcommand === 'show' || subcommand === 'apply' || subcommand === 'path') && rest.length === 1)
    || (subcommand === 'get' && rest.length === 2 && validKey)
    || (subcommand === 'set' && rest.length === 3 && validKey)
  );
  if (!shapeValid) {
    throw new UsageError(`Usage: ${specFor('config').usage}`);
  }
  if (subcommand === 'set') parseSettingArgument(key as Parameters<typeof parseSettingArgument>[0], value as string);
  return { args: rest, json };
}

/**
 * Single source of truth for command syntax. Both help output and argument
 * validation derive from the same specification so they cannot drift apart.
 */
export function parseCommand(argv: string[]): ParsedCommand {
  const { args: stripped, quiet, verbose, noInput } = flagContext(argv);
  const base: ParsedCommand = {
    name: 'help', args: [], json: false, timing: false, quiet, verbose, noInput, includeStatus: false,
  };
  if (stripped.length === 0) return { ...base, includeStatus: true };

  const [command, ...rest] = stripped;
  if (command === '-h' || command === '--help') return { ...base, name: 'help' };
  if (command === '--version') return parseVersion(rest, base);

  const names = COMMAND_SPECS.map((spec) => spec.name);
  if (!names.includes(command as CliCommandName)) {
    throw new UsageError(`Unknown command: ${command}. Run brc help.`);
  }
  const name = command as CliCommandName;
  if (name === 'version') return parseVersion(rest, base);
  if (name === 'help') {
    if (rest.includes('--help')) return { ...base, name: 'help' };
    if (rest.length === 0) return { ...base, name: 'help' };
    if (rest.length !== 1 || !names.includes(rest[0] as CliCommandName)) {
      throw new UsageError(`Usage: ${specFor('help').usage}`);
    }
    return { ...base, name: 'help', args: [rest[0]] };
  }
  if (rest.includes('--help')) return { ...base, name: 'help', args: [name] };

  switch (name) {
    case 'setup':
    case 'stop':
    case 'restart':
    case 'clean':
      if (rest.length !== 0) throw new UsageError(`The ${name} command does not accept extra arguments.`);
      return { ...base, name };
    case 'start': {
      const extra = rest.filter((value) => value !== '--timing');
      if (extra.length !== 0) throw new UsageError('The start command does not accept extra arguments. Use --timing to show stages.');
      return { ...base, name, timing: rest.includes('--timing'), args: rest };
    }
    case 'status': {
      const extra = rest.filter((value) => value !== '--json');
      if (extra.length !== 0) throw new UsageError(`Usage: ${specFor('status').usage}`);
      return { ...base, name, json: rest.includes('--json'), args: rest };
    }
    case 'logs': {
      if (rest.length > 1) throw new UsageError(`Usage: ${specFor('logs').usage}`);
      if (rest[0] && !(LOG_COMPONENTS as readonly string[]).includes(rest[0])) {
        throw new UsageError(`logs component must be one of: ${LOG_COMPONENTS.join(', ')}.`);
      }
      return { ...base, name, args: rest, logComponent: rest[0] as ParsedCommand['logComponent'] };
    }
    case 'config': {
      const parsed = parseConfigArgs(rest);
      return { ...base, name, args: parsed.args, json: parsed.json };
    }
    case 'update':
      if (rest.length !== 1 || rest[0] !== 'traefik') throw new UsageError(`Usage: ${specFor('update').usage}`);
      return { ...base, name, args: rest };
    case 'uninstall':
      if (rest.length === 0) throw new UsageError('Non-interactive uninstall requires --yes: brc uninstall --yes');
      if (rest.length !== 1 || rest[0] !== '--yes') throw new UsageError(`Usage: ${specFor('uninstall').usage}`);
      return { ...base, name, args: rest };
    case 'diagnose': {
      const values = rest.filter((value) => value !== '--json');
      if (values.length !== 1 || !DIAGNOSE_TARGETS.includes(values[0] as DiagnoseTarget)) {
        throw new UsageError(`Usage: ${specFor('diagnose').usage}`);
      }
      return {
        ...base,
        name,
        args: values,
        json: rest.includes('--json'),
        diagnose: values[0] as DiagnoseTarget,
      };
    }
    default:
      throw new UsageError(`Unknown command: ${name}. Run brc help.`);
  }
}

function parseVersion(rest: string[], base: ParsedCommand): ParsedCommand {
  if (rest.length > 1 || (rest[0] && rest[0] !== '--json')) throw new UsageError(`Usage: ${specFor('version').usage}`);
  return { ...base, name: 'version', json: rest[0] === '--json', args: rest };
}
