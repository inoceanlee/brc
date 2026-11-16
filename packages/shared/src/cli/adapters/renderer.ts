import type { CliExitCode, CliResult } from '../core/result.js';

export type CliOutputFormat = 'table' | 'plain' | 'json' | 'yaml';

export interface CliRenderOptions {
  format: CliOutputFormat;
  quiet?: boolean;
  verbose?: boolean;
  stringifyYaml?: (data: unknown) => string;
}

export interface CliStreams {
  stdout(text: string): void;
  stderr(text: string): void;
}

function formatPlain(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return String(data);
  if (Array.isArray(data)) return data.map(formatPlain).join('\n');
  return Object.entries(data).map(([key, value]) => {
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return key + ': ' + rendered;
  }).join('\n');
}

export function renderCliResult(
  result: CliResult,
  options: CliRenderOptions,
  streams: CliStreams,
): CliExitCode {
  if (result.status === 'error') {
    const error = result.error;
    if (!error) throw new Error('CLI error result requires an error object.');
    if (options.format === 'json') {
      streams.stderr(JSON.stringify({
        code: error.code,
        exit_code: error.exitCode,
        message: error.message,
        run: error.run,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      }) + '\n');
    } else {
      streams.stderr(error.message + '\n' + (error.run ? 'Run: ' + error.run + '\n' : ''));
    }
    return error.exitCode;
  }
  if (result.error) throw new Error('Successful CLI result cannot carry an error.');
  if (result.data !== undefined) {
    let output: string;
    switch (options.format) {
      case 'json': output = JSON.stringify(result.data); break;
      case 'yaml':
        if (!options.stringifyYaml) throw new Error('YAML renderer requires a serializer.');
        output = options.stringifyYaml(result.data);
        break;
      case 'plain':
      case 'table': output = formatPlain(result.data); break;
      default: throw new Error('Unsupported CLI output format.');
    }
    if (output) streams.stdout(output.endsWith('\n') ? output : output + '\n');
  }
  if (!options.quiet && options.verbose && result.diagnostics?.length) {
    for (const message of result.diagnostics) streams.stderr(message + '\n');
  }
  return 0;
}
