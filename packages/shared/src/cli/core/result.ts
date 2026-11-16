export type CliExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130 | 143;

export interface CliError {
  code: string;
  exitCode: Exclude<CliExitCode, 0>;
  message: string;
  run: string;
  retryable: boolean;
  details?: unknown;
}

export interface CliResult<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  error?: CliError;
  diagnostics?: readonly string[];
}

export function cliSuccess<T>(data: T, diagnostics?: readonly string[]): CliResult<T> {
  return { status: 'success', data, ...(diagnostics ? { diagnostics } : {}) };
}

export function cliFailure(error: CliError, diagnostics?: readonly string[]): CliResult<never> {
  return { status: 'error', error, ...(diagnostics ? { diagnostics } : {}) };
}
