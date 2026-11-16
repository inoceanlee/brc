export type LogLevel = 'emergency' | 'alert' | 'critical' | 'error'
  | 'warning' | 'notice' | 'info' | 'debug';

export type DiagnosticSink = (level: LogLevel, message: string) => void;
export type AgentLogger = Record<LogLevel, (message: string, data?: unknown) => void> & {
  bind(sink: DiagnosticSink): () => void;
};


function redact(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(deviceToken|access_token|password|secret)(["'=:\s]+)[^\s,}]+/gi, '$1$2[redacted]');
}

export function createAgentLogger(): AgentLogger {
  let sink: DiagnosticSink | undefined;
  const emit = (level: LogLevel, message: string): void => {
    const safe = redact(message);
    if (sink) sink(level, safe);
    else process.stderr.write('[agent:' + level + '] ' + safe + '\n');
  };
  return {
    bind(next: DiagnosticSink): () => void {
      sink = next;
      return () => { if (sink === next) sink = undefined; };
    },
    emergency: (message: string, _data?: unknown) => emit('emergency', message),
    alert: (message: string, _data?: unknown) => emit('alert', message),
    critical: (message: string, _data?: unknown) => emit('critical', message),
    error: (message: string, _data?: unknown) => emit('error', message),
    warning: (message: string, _data?: unknown) => emit('warning', message),
    notice: (message: string, _data?: unknown) => emit('notice', message),
    info: (message: string, _data?: unknown) => emit('info', message),
    debug: (message: string, _data?: unknown) => emit('debug', message),
  };
}



export function logToStderr(level: LogLevel, message: string): void {
  process.stderr.write('[agent:' + level + '] ' + redact(message) + '\n');
}
