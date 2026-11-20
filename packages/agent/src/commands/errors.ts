import type { CliExitCode, CliError } from 'brc-shared';
import { AgentUsageError } from './parser.js';
import { TokenInputError } from '../adapters/terminal/secret-input.js';

type FailureExitCode = Exclude<CliExitCode, 0>;

export interface ClassifiedAgentError {
  code: string;
  exitCode: FailureExitCode;
  run: string;
  retryable: boolean;
}

function classify(signature: string, exitCode: FailureExitCode): ClassifiedAgentError {
  const code = signature === 'usage' ? 'INVALID_USAGE'
    : signature === 'permission' ? 'PERMISSION_DENIED'
      : signature === 'notfound' ? 'NOT_FOUND'
        : signature === 'conflict' ? 'CONFLICT' : 'AGENT_ERROR';
  return {
    code,
    exitCode,
    run: signature === 'usage' ? 'brc-agent help' : 'brc-agent connect --no-browser',
    retryable: signature === 'runtime',
  };
}

export function classifyAgentError(error: unknown): ClassifiedAgentError {
  if (error instanceof AgentUsageError || error instanceof TokenInputError) return classify('usage', 2);
  const source = error as { code?: unknown; exitCode?: unknown };
  if (source?.exitCode === 3 || source?.code === 'EACCES' || source?.code === 'EPERM' || source?.code === 'EROFS') return classify('permission', 3);
  if (source?.exitCode === 4 || source?.code === 'ENOENT') return classify('notfound', 4);
  if (source?.exitCode === 5 || source?.code === 'EEXIST') return classify('conflict', 5);
  if (source?.exitCode === 2) return classify('usage', 2);
  return classify('runtime', 1);
}

export function toCliError(error: unknown, message: string): CliError {
  const info = classifyAgentError(error);
  return {
    code: info.code,
    exitCode: info.exitCode as Exclude<CliExitCode, 0>,
    message,
    run: info.run,
    retryable: info.retryable,
  };
}
