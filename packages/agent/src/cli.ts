#!/usr/bin/env node
import { createRequire } from 'node:module';
import { cliFailure, cliSuccess, renderCliResult, type CliResult } from 'brc-shared';
import { parseAgentInvocation, AgentUsageError } from './commands/parser.js';
import { runAgentLocalCommand } from './commands/local.js';
import { TokenInputError } from './adapters/terminal/secret-input.js';

function sanitizeError(message: string): string {
  return message.replace(/Bearer\\s+\\S+/gi, 'Bearer [redacted]').replace(/(deviceToken|token|secret)(["'=:\\s]+)[^\\s,}]+/gi, '$1$2[redacted]');
}

const requireFromHere = createRequire(import.meta.url);
const yaml = (value: unknown): string => {
  const codec = requireFromHere('js-yaml') as { safeDump(value: unknown, options: { noRefs: boolean }): string };
  return codec.safeDump(value, { noRefs: true });
};

const argv = process.argv.slice(2);
let format: 'table' | 'plain' | 'json' | 'yaml' = argv.includes('--json') || argv.includes('--output=json')
  || argv.some((value, index) => (value === '--output' || value === '-o') && argv[index + 1] === 'json') ? 'json' : 'plain';
let quiet = false;
let verbose = false;

async function run(): Promise<CliResult | null> {
  const invocation = parseAgentInvocation(argv);
  format = invocation.format;
  quiet = invocation.quiet;
  verbose = invocation.verbose;
  if (invocation.noTelemetry || invocation.offline) process.env.DO_NOT_TRACK = '1';
  if (invocation.command === 'connect' && invocation.preview) {
    return cliSuccess({ action: 'connect', changed: false, preview: true, relay: invocation.relay ?? null });
  }
  if (invocation.command === 'config allow-dir' || invocation.command === 'connect') {
    const { configureAgentServices } = await import('./composition.js');
    configureAgentServices();
  }
  if (invocation.command !== 'connect') return runAgentLocalCommand(invocation);
  const { runAgentConnection } = await import('./adapters/transport/connection.js');
  await runAgentConnection(invocation);
  return null;
}

try {
  const result = await run();
  if (result) process.exitCode = renderCliResult(result, { format, quiet, verbose, stringifyYaml: yaml }, {
    stdout: (data) => process.stdout.write(data),
    stderr: (data) => process.stderr.write(data),
  });
} catch (error) {
  const usage = error instanceof AgentUsageError || error instanceof TokenInputError;
  const result = cliFailure({
    code: usage ? 'INVALID_USAGE' : 'AGENT_ERROR',
    exitCode: usage ? 2 : 1,
    message: sanitizeError(error instanceof Error ? error.message : String(error)),
    run: usage ? 'brc-agent help' : 'brc-agent connect --no-browser',
    retryable: !usage,
  });
  process.exitCode = renderCliResult(result, { format, quiet, verbose, stringifyYaml: yaml }, {
    stdout: (data) => process.stdout.write(data),
    stderr: (data) => process.stderr.write(data),
  });
}
