import { isBrcSettingKey, parseSettingArgument } from '../config/settings.js';
import { GLOBAL_FLAGS, normalizeGlobalOptions } from './options.js';
import { readProductVersion } from '../config/product.js';

export type CliCommandName =
  | 'help' | 'version' | 'setup' | 'start' | 'stop' | 'restart' | 'status'
  | 'logs' | 'config' | 'update' | 'uninstall' | 'clean' | 'diagnose' | 'completion';

export type DiagnoseTarget = 'startup' | 'lifecycle' | 'functions' | 'resources' | 'logs';

export interface DiagnosticLogFilter {
  since?: string;
  until?: string;
  source?: string;
  runId?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  component?: 'cli' | 'relay' | 'agent' | 'traefik' | 'native';
  limit?: number;
}

export interface CliLogComponents {
  readonly components: readonly string[];
}

export const LOG_COMPONENTS = ['relay', 'agent', 'traefik', 'cli'] as const;
export const DIAGNOSE_TARGETS: readonly DiagnoseTarget[] = ['startup', 'lifecycle', 'functions', 'resources', 'logs'];

export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string, readonly run?: string) {
    super(message);
  }
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
  output: 'table' | 'plain' | 'json' | 'yaml';
  debug: boolean;
  noColor: boolean;
  interactive: boolean;
  helpBrief: boolean;
  timeoutMs?: number;
  confirm?: string;
  offline: boolean;
  noTelemetry: boolean;
  preview: boolean;
  diagnose?: DiagnoseTarget;
  diagnoseFilter?: DiagnosticLogFilter;
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
    examples: ['brc setup', 'BRC_ADMIN_PASSWORD=secret brc setup --no-input', 'brc setup --offline'],
  },
  {
    name: 'start',
    usage: 'brc start [--timing]',
    summary: 'Start Relay, Traefik, and Agent.',
    examples: ['brc start', 'brc start --timing', 'brc start --json'],
  },
  {
    name: 'stop',
    usage: 'brc stop',
    summary: 'Stop the managed services.',
    examples: ['brc stop', 'brc stop --json', 'brc stop --timeout 15s'],
  },
  {
    name: 'restart',
    usage: 'brc restart',
    summary: 'Restart the managed services.',
    examples: ['brc restart', 'brc restart --json', 'brc restart --timeout 2m'],
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
    examples: ['brc logs', 'brc logs cli', 'brc logs relay --json'],
  },
  {
    name: 'config',
    usage: 'brc config <show|get|set|apply|path> [key] [value] [--json] [--preview]',
    summary: 'Show or update local settings.',
    examples: ['brc config show', 'brc config show --json', 'brc config set proxy.rate.average 20'],
  },
  {
    name: 'update',
    usage: 'brc update traefik [--preview]',
    summary: 'Update the managed Traefik binary.',
    examples: ['brc update traefik', 'brc update traefik --preview', 'brc update traefik --offline'],
  },
  {
    name: 'clean',
    usage: 'brc clean',
    summary: 'Run safe cleanup of expired BRC data.',
    examples: ['brc clean', 'brc clean --json', 'brc clean --timeout 15s'],
  },
  {
    name: 'uninstall',
    usage: 'brc uninstall --confirm <data-root> [--yes]',
    summary: 'Stop services and remove BRC data and the global package.',
    examples: ['brc uninstall --confirm <data-root>', 'brc uninstall --confirm /path/to/BRC --yes'],
  },
  {
    name: 'diagnose',
    usage: 'brc diagnose <startup|lifecycle|functions|resources|logs> [--output <format>]',
    summary: 'Show startup and lifecycle timings, function timings, resource samples, or structured logs.',
    examples: ['brc diagnose startup', 'brc diagnose logs --level error --json', 'brc diagnose resources --plain'],
  },
  {
    name: 'completion',
    usage: 'brc completion <powershell|bash|zsh|fish>',
    summary: 'Generate shell command completion.',
    examples: ['brc completion powershell', 'brc completion bash', 'brc completion zsh'],
  },
];

const TOP_LEVEL_EXAMPLES = [
  'brc start',
  'brc status --json',
  'brc config show',
];

const UNINSTALL_NOTE = [
  'pnpm remove -g @inoceanlee/brc removes only the package and keeps BRC data.',
  'Run brc uninstall --yes to stop services and remove BRC data and the global package.',
];

function docsUrl(): string {
  return `https://github.com/inoceanlee/brc/tree/v${readProductVersion()}`;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

export function suggestCommand(name: string): string | undefined {
  let best: string | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of COMMAND_SPECS) {
    const value = editDistance(name.toLowerCase(), candidate.name);
    if (value < distance) {
      distance = value;
      best = candidate.name;
    }
  }
  return distance <= 3 ? best : undefined;
}

function unknownCommand(name: string): UsageError {
  const suggestion = suggestCommand(name);
  return new UsageError(`Unknown command: ${name}.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Run brc help.`);
}

function specFor(name: CliCommandName): CommandSpec {
  const spec = COMMAND_SPECS.find((item) => item.name === name);
  if (!spec) throw new UsageError(`Unknown command: ${name}. Run brc help.`);
  return spec;
}

export function helpText(command?: CliCommandName, brief = false): string {
  if (command) {
    const spec = specFor(command);
    const lines = [spec.usage, '', spec.summary];
    if (!brief && spec.examples.length) {
      lines.push('', 'Examples:');
      for (const example of spec.examples) lines.push(`  ${example}`);
    }
    if (!brief) lines.push('', `Docs: ${docsUrl()}`);
    return lines.join('\n');
  }
  const lines = ['BRC unified CLI', '', 'Usage: brc <command>', '', 'Commands:'];
  for (const spec of COMMAND_SPECS) {
    lines.push(`  ${spec.usage.replace(/^brc /, 'brc ').padEnd(46)} ${spec.summary}`);
  }
  lines.push('', 'Global flags:');
  for (const flag of GLOBAL_FLAGS) {
    const label = flag.short ? `${flag.short}, ${flag.long}` : flag.long;
    lines.push(`  ${label.padEnd(46)} ${flag.description}`);
  }
  if (!brief) {
    lines.push('', 'Examples:');
    for (const example of TOP_LEVEL_EXAMPLES) lines.push(`  ${example}`);
    lines.push('', `Docs: ${docsUrl()}`, '', ...UNINSTALL_NOTE);
  }
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
    const subcommands = ['show', 'get', 'set', 'apply', 'path'];
    if (!subcommand) throw new UsageError(`Missing config subcommand. Expected: ${subcommands.join(', ')}.`);
    if (!subcommands.includes(subcommand)) throw new UsageError(`Unknown config subcommand "${subcommand}". Expected: ${subcommands.join(', ')}.`);
    if ((subcommand === 'get' || subcommand === 'set') && key === undefined) {
      throw new UsageError(`Missing required <key> for brc config ${subcommand}.`);
    }
    if ((subcommand === 'get' || subcommand === 'set') && !validKey) {
      throw new UsageError(`Invalid setting key "${key}" for brc config ${subcommand}.`);
    }
    if (subcommand === 'set' && value === undefined) throw new UsageError(`Missing required <value> for brc config set ${key}.`);
    throw new UsageError(`Usage: ${specFor('config').usage}`);
  }
  if (subcommand === 'set') parseSettingArgument(key as Parameters<typeof parseSettingArgument>[0], value as string);
  return { args: rest, json };
}

/**
 * Single source of truth for command syntax. Both help output and argument
 * validation derive from the same specification so they cannot drift apart.
 */
function parseLegacyCommand(argv: string[]): ParsedCommand {
  const { args: stripped, quiet, verbose, noInput } = flagContext(argv);
  const base: ParsedCommand = {
    name: 'help', args: [], json: false, timing: false, quiet, verbose, noInput, includeStatus: false,
    output: 'table', debug: false, noColor: false, interactive: false, offline: false, noTelemetry: false, preview: false,
    helpBrief: false,
  };
  if (stripped.length === 0) return { ...base, helpBrief: true };

  const [command, ...rest] = stripped;
  if (command === '-h') return { ...base, name: 'help', helpBrief: true };
  if (command === '--help') return { ...base, name: 'help' };
  if (command === '--version') return parseVersion(rest, base);

  const names = COMMAND_SPECS.map((spec) => spec.name);
  if (!names.includes(command as CliCommandName)) {
    throw unknownCommand(command);
  }
  const name = command as CliCommandName;
  if (name === 'version') return parseVersion(rest, base);
  if (name === 'help') {
    if (rest.includes('-h')) return { ...base, name: 'help', helpBrief: true };
    if (rest.includes('--help')) return { ...base, name: 'help' };
    if (rest.length === 0) return { ...base, name: 'help' };
    if (rest.length !== 1 || !names.includes(rest[0] as CliCommandName)) {
      throw new UsageError(`Usage: ${specFor('help').usage}`);
    }
    return { ...base, name: 'help', args: [rest[0]] };
  }
  if (rest.includes('-h')) return { ...base, name: 'help', args: [name], helpBrief: true };
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
    case 'uninstall': {
      let confirm: string | undefined;
      let yes = false;
      for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === '--yes' || token === '-y') yes = true;
        else if (token === '--confirm') {
          confirm = rest[++index];
          if (!confirm) throw new UsageError('--confirm requires the BRC data root path.');
        } else throw new UsageError(`Usage: ${specFor('uninstall').usage}`);
      }
      if (!confirm) throw new UsageError('Uninstall requires --confirm <data-root>.');
      return { ...base, name, args: rest, confirm };
    }
    case 'completion':
      if (rest.length !== 1 || !['powershell', 'bash', 'zsh', 'fish'].includes(rest[0])) {
        throw new UsageError(`Usage: ${specFor('completion').usage}`);
      }
      return { ...base, name, args: rest };
    case 'diagnose': {
      const values = rest.filter((value) => value !== '--json');
      if (values.length < 1 || !DIAGNOSE_TARGETS.includes(values[0] as DiagnoseTarget)) {
        throw new UsageError(`Usage: ${specFor('diagnose').usage}`);
      }
      const diagnose = values[0] as DiagnoseTarget;
      if (diagnose === 'logs') {
        return {
          ...base,
          name,
          args: values,
          json: rest.includes('--json'),
          diagnose,
          diagnoseFilter: parseDiagnosticLogFilter(values.slice(1)),
        };
      }
      if (values.length !== 1) throw new UsageError(`Usage: ${specFor('diagnose').usage}`);
      return {
        ...base,
        name,
        args: values,
        json: rest.includes('--json'),
        diagnose,
      };
    }
    default:
      throw unknownCommand(name);
  }
}

function parseDiagnosticLogFilter(tokens: readonly string[]): DiagnosticLogFilter {
  const filter: DiagnosticLogFilter = {};
  const levels = ['debug', 'info', 'warn', 'error'];
  const components = ['cli', 'relay', 'agent', 'traefik', 'native'];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const assignment = /^(--[a-z-]+)=(.*)$/.exec(token);
    const flag = assignment?.[1] ?? token;
    const value = assignment?.[2] ?? tokens[++index];
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value.`);
    switch (flag) {
      case '--since': filter.since = value; break;
      case '--until': filter.until = value; break;
      case '--source': filter.source = value; break;
      case '--run-id': filter.runId = value; break;
      case '--level':
        if (!levels.includes(value)) throw new UsageError('--level must be debug, info, warn, or error.');
        filter.level = value as DiagnosticLogFilter['level'];
        break;
      case '--component':
        if (!components.includes(value)) throw new UsageError('--component must be cli, relay, agent, traefik, or native.');
        filter.component = value as DiagnosticLogFilter['component'];
        break;
      case '--limit': {
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit <= 0) throw new UsageError('--limit must be a positive integer.');
        filter.limit = limit;
        break;
      }
      default:
        throw new UsageError(`Unknown diagnose logs flag: ${flag}.`);
    }
  }
  return filter;
}

function parseVersion(rest: string[], base: ParsedCommand): ParsedCommand {
  if (rest.length > 1 || (rest[0] && rest[0] !== '--json')) throw new UsageError(`Usage: ${specFor('version').usage}`);
  return { ...base, name: 'version', json: rest[0] === '--json', args: rest };
}

export function parseCommand(argv: string[]): ParsedCommand {
  const global = normalizeGlobalOptions(argv);
  const result = parseLegacyCommand(global.args);
  const json = global.output === 'json' || result.json;
  return {
    ...result,
    json,
    output: json ? 'json' : global.output,
    quiet: global.quiet,
    verbose: global.verbose,
    noInput: global.noInput,
    debug: global.debug,
    noColor: global.noColor,
    interactive: global.interactive,
    timeoutMs: global.timeoutMs,
    offline: global.offline,
    noTelemetry: global.noTelemetry,
    preview: global.preview,
    includeStatus: false,
    helpBrief: global.helpBrief || result.helpBrief,
  };
}
