import type { Readable } from 'node:stream';

export class TokenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenInputError';
  }
}

export function readTokenFromStdin(input: Readable = process.stdin, timeoutMs = 5000): Promise<string> {
  if ((input as Readable & { isTTY?: boolean }).isTTY) {
    throw new TokenInputError('--token-stdin requires input from a pipe, not an interactive terminal.');
  }
  return new Promise((resolve, reject) => {
    let result = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (!result.trim()) reject(new TokenInputError('--token-stdin requires a nonempty token.'));
      else resolve(result.trim());
    };
    const onData = (chunk: Buffer | string) => {
      result += chunk.toString();
      if (result.length > 8192) finish(new TokenInputError('Token input exceeds the maximum supported length.'));
    };
    const onEnd = () => finish();
    const onError = () => finish(new TokenInputError('Unable to read token from stdin.'));
    const timer = setTimeout(() => finish(new TokenInputError('Reading --token-stdin timed out.')), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}
