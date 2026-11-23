import { UsageError } from './parser.js';
import type { CliOutputFormat } from 'brc-shared';

export interface GlobalFlagDefinition {
  readonly long: string;
  readonly short?: string;
  readonly description: string;
}

export const GLOBAL_FLAGS: readonly GlobalFlagDefinition[] = [
  { long: '--help', short: '-h', description: 'Show help.' },
  { long: '--quiet', short: '-q', description: 'Suppress progress output.' },
  { long: '--verbose', short: '-v', description: 'Include additional diagnostics.' },
  { long: '--debug', description: 'Include error stack details.' },
  { long: '--no-color', description: 'Disable terminal control sequences.' },
  { long: '--no-input', description: 'Never prompt.' },
  { long: '--interactive', description: 'Allow prompts in CI when stdin and stderr are TTYs.' },
  { long: '--output <table|plain|json|yaml>', short: '-o', description: 'Select the output format.' },
  { long: '--json', description: 'Output JSON data.' },
  { long: '--plain', description: 'Output headerless plain records.' },
  { long: '--timeout <duration>', description: 'Bound command waits (for example 1500ms, 15s, 2m).' },
  { long: '--offline', description: 'Prevent network release lookups and downloads.' },
  { long: '--no-telemetry', description: 'Set DO_NOT_TRACK=1 for managed child processes.' },
  { long: '--preview', description: 'Preview supported config and Traefik update changes.' },
  { long: '--yes', short: '-y', description: 'Confirm an unrecoverable operation.' },
];

export interface GlobalOptions {
  args: string[];
  helpBrief: boolean;
  output: CliOutputFormat;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  noInput: boolean;
  interactive: boolean;
  noColor: boolean;
  offline: boolean;
  noTelemetry: boolean;
  preview: boolean;
  timeoutMs?: number;
}

const FORMATS: readonly string[] = ['table', 'plain', 'json', 'yaml'];

export function detectOutputFormat(argv: readonly string[]): CliOutputFormat | undefined {
  let format: CliOutputFormat | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') format = 'json';
    else if (token === '--plain') format = 'plain';
    else if (token === '--output' || token === '-o') {
      const value = argv[index + 1];
      if (value && FORMATS.includes(value)) {
        format = value as CliOutputFormat;
        index += 1;
      }
    } else if (token.startsWith('--output=')) {
      const value = token.slice(9);
      if (FORMATS.includes(value)) format = value as CliOutputFormat;
    } else if (/^-o[^-]/.test(token)) {
      const value = token.slice(2);
      if (FORMATS.includes(value)) format = value as CliOutputFormat;
    }
  }
  return format;
}

const BOOL_FLAGS = new Map<string, keyof GlobalOptions>([
  ['--quiet', 'quiet'], ['--verbose', 'verbose'], ['--debug', 'debug'],
  ['--no-input', 'noInput'], ['--interactive', 'interactive'],
  ['--no-color', 'noColor'], ['--offline', 'offline'],
  ['--no-telemetry', 'noTelemetry'], ['--preview', 'preview'],
]);
export function normalizeGlobalOptions(argv: readonly string[]): GlobalOptions {
  const result: GlobalOptions = {
    args: [], helpBrief: false, output: 'table', quiet: false, verbose: false,
    debug: false, noInput: false, interactive: false, noColor: false,
    offline: false, noTelemetry: false, preview: false,
  };
  let explicitFormat: string | undefined;
  let optionsEnded = false;
  const chooseFormat = (value: string): void => {
    if (!FORMATS.includes(value)) throw new UsageError('Output format must be table, json, yaml, or plain.');
    if (explicitFormat && explicitFormat !== value) throw new UsageError('Conflicting output formats.');
    explicitFormat = value;
    result.output = value as CliOutputFormat;
  };
  const setDuration = (value: string): void => {
    const match = /^(\d+)(ms|s|m)?$/.exec(value);
    if (!match) throw new UsageError('--timeout expects a positive duration such as 500ms, 15s, or 2m.');
    const ms = Number(match[1]) * (match[2] === 'm' ? 60000 : match[2] === 's' ? 1000 : 1);
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new UsageError('--timeout must be a positive duration.');
    result.timeoutMs = ms;
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (optionsEnded) { result.args.push(token); continue; }
    if (token === '--') { optionsEnded = true; continue; }
    if (token === '--json') { chooseFormat('json'); continue; }
    if (token === '--plain') { chooseFormat('plain'); continue; }
    if (token === '--output' || token === '-o' || token === '--timeout') {
      const value = argv[++index];
      if (!value) throw new UsageError(token + ' requires a value.');
      if (token === '--timeout') setDuration(value); else chooseFormat(value);
      continue;
    }
    if (token.startsWith('--output=')) { chooseFormat(token.slice(9)); continue; }
    if (token.startsWith('--timeout=')) { setDuration(token.slice(10)); continue; }
    if (/^-o[^-]/.test(token)) { chooseFormat(token.slice(2)); continue; }
    const assignment = /^(--[\w-]+)=(true|false)$/.exec(token);
    const boolName = BOOL_FLAGS.get(assignment?.[1] ?? token);
    if (boolName) {
      (result as unknown as Record<string, unknown>)[boolName] = assignment ? assignment[2] === 'true' : true;
      continue;
    }
    if (/^-[a-zA-Z]{2,}$/.test(token)) {
      for (const flag of token.slice(1)) {
        if (flag === 'q') result.quiet = true;
        else if (flag === 'v') result.verbose = true;
        else if (flag === 'n') result.preview = true;
        else if (flag === 'y') result.args.push('--yes');
        else if (flag === 'h') { result.args.push('--help'); result.helpBrief = true; }
        else throw new UsageError('Unknown short flag: -' + flag);
      }
      continue;
    }
    if (token === '-q') { result.quiet = true; continue; }
    if (token === '-v') { result.verbose = true; continue; }
    if (token === '-n') { result.preview = true; continue; }
    if (token === '-y') { result.args.push('--yes'); continue; }
    if (token === '-h') { result.args.push('--help'); result.helpBrief = true; continue; }
    result.args.push(token);
  }
  if (result.noInput) result.interactive = false;
  if (result.verbose) result.quiet = false;
  return result;
}
