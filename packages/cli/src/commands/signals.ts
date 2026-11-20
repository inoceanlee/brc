export const SIGNAL_EXIT_CODES: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
});

export interface CancellationOptions {
  abort?: (signal: 'SIGINT' | 'SIGTERM') => void;
  flush: () => Promise<void>;
  exit: (code: number) => void;
  signalSource?: {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
}

/**
 * Cancellation flushes diagnostics once and exits with the conventional
 * signal code. A second signal exits immediately instead of waiting again.
 */
export function installCancellationHandlers(options: CancellationOptions): () => void {
  const source = options.signalSource ?? process;
  const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
  let flushing: Promise<void> | undefined;

  const handle = (signal: 'SIGINT' | 'SIGTERM') => () => {
    const code = SIGNAL_EXIT_CODES[signal];
    if (flushing) {
      options.exit(code);
      return;
    }
    try { options.abort?.(signal); } catch {}
    flushing = options.flush().catch(() => undefined);
    void flushing.then(() => options.exit(code));
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const listener = handle(signal);
    listeners.set(signal, listener);
    source.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) source.removeListener(signal, listener);
  };
}
