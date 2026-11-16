import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../config/core/settings.js';

export interface ManagedHealth {
  state: 'running' | 'degraded' | 'pairing';
  detail: string;
}

export interface ManagedControlServer {
  port: number;
  close(): Promise<void>;
}

export interface ManagedControlHandlerOptions {
  token: string;
  health: () => ManagedHealth | Promise<ManagedHealth>;
  stop: () => void | Promise<void>;
  onStopError: (error: unknown) => void;
  onShutdownStart?: () => void;
  onShutdownResponse?: () => void;
}

export interface ManagedControlIdentity {
  id: string;
  service: string;
  pid: number;
  port: number;
}
function shutdownErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, shutdownErrorMessage);
    return causes.length ? `${error.message}: ${causes.join('; ')}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}


export function createManagedControlRequestListener(options: ManagedControlHandlerOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => void {
  let stopping: Promise<{ ok: true } | { ok: false; error: { message: string } }> | undefined;
  const expected = Buffer.from(options.token);
  return (request, response) => {
    const address = request.socket.remoteAddress ?? '';
    const loopback = address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? Buffer.from(request.headers.authorization.slice(7))
      : Buffer.alloc(0);
    if (!loopback || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(404).end();
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      void Promise.resolve().then(() => options.health()).then((health) => {
        const ok = health.state === 'running';
        response.writeHead(ok ? 200 : health.state === 'pairing' ? 202 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok, state: health.state, detail: health.detail }));
      }).catch(() => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, state: 'degraded', detail: 'Health check failed.' }));
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/shutdown') {
      options.onShutdownStart?.();
      stopping ??= Promise.resolve().then(() => options.stop()).then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          try { options.onStopError(error); } catch {}
          return { ok: false as const, error: { message: shutdownErrorMessage(error) } };
        },
      );
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        options.onShutdownResponse?.();
      };
      response.once('finish', complete);
      response.once('close', complete);
      void stopping.then((result) => {
        if (response.destroyed) return;
        response.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify(result));
      });
      return;
    }

    response.writeHead(404).end();
  };
}

export async function publishManagedControlReadyFile(
  readyFile: string,
  identity: ManagedControlIdentity,
): Promise<void> {
  const temporary = readyFile + '.' + identity.pid + '.tmp';
  await mkdir(path.dirname(readyFile), { recursive: true });
  await writeFile(temporary, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, readyFile);
}

export async function startManagedControlServer(options: {
  server: Server;
  token?: string;
  readyFile?: string;
  id?: string;
  service?: string;
  health: () => ManagedHealth | Promise<ManagedHealth>;
  stop: () => void | Promise<void>;
  shutdownTimeoutMs?: number;
  onStopError: (error: unknown) => void;
}): Promise<ManagedControlServer | undefined> {
  const { token, readyFile, id, service } = options;
  if (!token && !readyFile && !id && !service) return undefined;
  if (!token || !readyFile || !id || !service) throw new Error('Incomplete BRC managed-control environment.');

  const server = options.server;
  let shutdownResponse: Promise<void> | undefined;
  let finishResponse: (() => void) | undefined;
  let business: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const closeServer = (): Promise<void> => closing ??= (async () => {
    await business?.catch(() => undefined);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        shutdownResponse,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(); }, options.shutdownTimeoutMs ?? DEFAULT_SETTINGS.runtime.shutdownTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      const deadline = setTimeout(() => server.closeAllConnections(), 1_000);
      deadline.unref();
      server.close((error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      });
    });
    if (timedOut) throw new Error('Managed shutdown did not finish before control server closure.');
  })();
  server.on('request', createManagedControlRequestListener({
    token,
    health: options.health,
    stop: () => business ??= Promise.resolve().then(() => options.stop()),
    onStopError: options.onStopError,
    onShutdownStart: () => {
      if (!business) {
        let timer: NodeJS.Timeout | undefined;
        let expired = false;
        const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SETTINGS.runtime.shutdownTimeoutMs;
        const deadline = Date.now() + timeoutMs;
        const actual = Promise.resolve().then(() => options.stop());
        void actual.catch(() => {
          if (expired) {
            try { options.onStopError(new Error('Managed shutdown failed after the deadline.')); } catch {}
          }
        });
        business = Promise.race([
          actual.then(() => {
            if (Date.now() >= deadline) throw new Error('Managed shutdown did not finish before the deadline.');
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error('Managed shutdown did not finish before the deadline.'));
            }, timeoutMs);
            timer.unref();
          }),
        ]).finally(() => clearTimeout(timer));
      }
      shutdownResponse ??= new Promise<void>((resolve) => { finishResponse = resolve; });
      void closeServer().catch(options.onStopError);
    },
    onShutdownResponse: () => {
      finishResponse?.();
    },
  }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer();
    throw new Error('BRC managed-control listener did not receive a TCP port.');
  }

  try {
    await publishManagedControlReadyFile(readyFile, {
      id, service, pid: process.pid, port: address.port,
    });
  } catch (error) {
    await closeServer();
    throw error;
  }

  return { port: address.port, close: closeServer };
}
