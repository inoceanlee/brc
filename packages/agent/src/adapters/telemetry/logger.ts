export type LogLevel = 'emergency' | 'alert' | 'critical' | 'error'
  | 'warning' | 'notice' | 'info' | 'debug';

type DiagnosticSink = (level: LogLevel, message: string) => void;
let diagnosticSink: DiagnosticSink | null = null;

export function installAgentLogSink(sink: DiagnosticSink): () => void {
  const previous = diagnosticSink;
  diagnosticSink = sink;
  return () => { diagnosticSink = previous; };
}

function redact(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(deviceToken|access_token|password|secret)(["'=:\s]+)[^\s,}]+/gi, '$1$2[redacted]');
}

export function log(level: LogLevel, message: string, _data?: unknown): void {
  const safe = redact(message);
  if (diagnosticSink) diagnosticSink(level, safe);
  else process.stderr.write('[agent:' + level + '] ' + safe + '\n');
}

export const logger = {
  emergency: (message: string, data?: unknown) => log('emergency', message, data),
  alert: (message: string, data?: unknown) => log('alert', message, data),
  critical: (message: string, data?: unknown) => log('critical', message, data),
  error: (message: string, data?: unknown) => log('error', message, data),
  warning: (message: string, data?: unknown) => log('warning', message, data),
  notice: (message: string, data?: unknown) => log('notice', message, data),
  info: (message: string, data?: unknown) => log('info', message, data),
  debug: (message: string, data?: unknown) => log('debug', message, data),
};

export function logToStderr(level: LogLevel, message: string): void {
  log(level, message);
}
