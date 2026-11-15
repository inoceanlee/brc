export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticComponent = 'cli' | 'relay' | 'agent' | 'traefik' | 'native';

export interface DiagnosticSource {
  file: string;
  function?: string;
}

export interface DiagnosticEvent {
  schema: 1;
  type: 'event';
  ts: string;
  level: DiagnosticLevel;
  component: DiagnosticComponent;
  runId?: string;
  instanceId?: string;
  source: DiagnosticSource;
  message: string;
  errorCode?: string;
  stack?: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticEventInput {
  level: DiagnosticLevel;
  component: DiagnosticComponent;
  source: DiagnosticSource;
  message: string;
  runId?: string;
  instanceId?: string;
  errorCode?: string;
  stack?: string;
  data?: Record<string, unknown>;
  now?: Date;
}

const SENSITIVE_KEY = /token|secret|password|passwd|apikey|api_key|cookie|authorization|credential|session|diff|content|prompt|query/i;
const MAX_TEXT = 512;
const MAX_DATA_ENTRIES = 24;
const MAX_DEPTH = 3;

function redactText(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, MAX_DATA_ENTRIES).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_DATA_ENTRIES)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(item, depth + 1);
    }
    return output;
  }
  return '[unsupported]';
}

/**
 * Only error codes and stack traces produced by BRC are kept. Messages are
 * truncated and sensitive keys are replaced so tokens, credentials, prompts
 * and file diffs never reach the diagnostic log.
 */
export function createDiagnosticEvent(input: DiagnosticEventInput): DiagnosticEvent {
  const stack = input.stack && input.level === 'error' ? redactText(input.stack) : undefined;
  return {
    schema: 1,
    type: 'event',
    ts: (input.now ?? new Date()).toISOString(),
    level: input.level,
    component: input.component,
    ...(input.runId ? { runId: redactText(input.runId) } : {}),
    ...(input.instanceId ? { instanceId: redactText(input.instanceId) } : {}),
    source: {
      file: redactText(input.source.file),
      ...(input.source.function ? { function: redactText(input.source.function) } : {}),
    },
    message: redactText(input.message),
    ...(input.errorCode ? { errorCode: input.errorCode.replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 64) } : {}),
    ...(stack ? { stack } : {}),
    ...(input.data ? { data: redactValue(input.data, 0) as Record<string, unknown> } : {}),
  };
}

export function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.schema === 1 && event.type === 'event'
    && typeof event.ts === 'string' && typeof event.message === 'string'
    && typeof event.component === 'string' && typeof event.level === 'string';
}
