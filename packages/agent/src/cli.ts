#!/usr/bin/env node
import { createRequire } from 'node:module';
import { cliFailure, cliSuccess, renderCliResult, createDiagnosticsRuntime, DiagnosticSession, FileDiagnosticLog, FileSnapshotStore, FunctionTiming, installFunctionProbe, NodeResourceSampler, resolveSettings, type CliResult } from 'brc-shared';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { resolveAgentPaths } from './adapters/storage/agent-paths.js';
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

async function createAgentDiagnostics() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.startsWith('BRC_DIAGNOSTICS_') || key === 'BRC_LOG_ROTATE_MIB'));
  const resolved = resolveSettings({ version: 1 }, env).settings;
  const settings = resolved.diagnostics;
  const directory = process.env.BRC_DIAGNOSTICS_DIR;
  const enabled = process.env.BRC_DIAGNOSTICS_ENABLED !== undefined && settings.enabled && !!directory;
  const instanceId = process.env.BRC_MANAGED_ID ?? String(process.pid);
  const functions = enabled ? new FunctionTiming() : undefined;
  if (functions) {
    for (const url of [
      new URL('./diagnostics-manifest.json', import.meta.url),
      new URL('./diagnostics-manifest.json', import.meta.resolve('brc-shared')),
    ]) {
      try {
        const manifest = JSON.parse(await readFile(url, 'utf8')) as {
          functions?: Array<{ id: string; name: string; file: string; line: number; kind: 'sync' | 'async' }>;
        };
        for (const entry of manifest.functions ?? []) functions.register(entry.id, entry);
      } catch {}
    }
  }
  const probe = functions ? installFunctionProbe(functions) : undefined;
  const resources = functions ? new NodeResourceSampler({ intervalMs: settings.resourceSampleMs }) : undefined;
  const store = functions && directory ? new FileSnapshotStore({
    directory, staleAfterMs: Math.max(settings.functionSnapshotMs * 3, 60_000),
  }) : undefined;
  const session = functions && resources && store ? new DiagnosticSession({
    service: 'agent', instanceId, store, functions, resources, snapshotIntervalMs: settings.functionSnapshotMs,
  }) : undefined;
  const maxBytes = resolved.logs.rotateMiB * 1024 * 1024;
  const log = functions ? new FileDiagnosticLog(path.join(resolveAgentPaths().logsDirectory, 'agent-diagnostics.log'), {
    maxRecordBytes: settings.maxRecordBytes, maxBytes,
  }) : undefined;
  const runtime = createDiagnosticsRuntime({ enabled, component: 'agent', instanceId, functions, resources, session, log });
  let stopped: Promise<void> | undefined;
  return {
    ...runtime,
    stop() {
      stopped ??= runtime.stop().finally(() => probe?.uninstall());
      return stopped;
    },
  };
}

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
  const diagnostics = await createAgentDiagnostics();
  try {
    await runAgentConnection(invocation, diagnostics, createServer(), {
      token: process.env.BRC_CONTROL_TOKEN,
      readyFile: process.env.BRC_CONTROL_READY_FILE,
      id: process.env.BRC_MANAGED_ID,
      service: process.env.BRC_MANAGED_SERVICE,
    });
  } catch (error) {
    await diagnostics.stop();
    throw error;
  }
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
