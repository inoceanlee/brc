import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
}

export interface ManagedControlIdentity {
  id: string;
  service: string;
  pid: number;
  port: number;
}

export function createManagedControlRequestListener(options: ManagedControlHandlerOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => void {
  let stopping = false;
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
      response.writeHead(202).end();
      if (!stopping) {
        stopping = true;
        setImmediate(() => {
          void Promise.resolve().then(() => options.stop()).catch((error) => options.onStopError(error));
        });
      }
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
  onStopError: (error: unknown) => void;
}): Promise<ManagedControlServer | undefined> {
  const { token, readyFile, id, service } = options;
  if (!token && !readyFile && !id && !service) return undefined;
  if (!token || !readyFile || !id || !service) throw new Error('Incomplete BRC managed-control environment.');

  const server = options.server;
  server.on('request', createManagedControlRequestListener({
    token,
    health: options.health,
    stop: options.stop,
    onStopError: options.onStopError,
  }));
  const closeServer = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });

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
