/**
 * BRC agent transport: outbound WebSocket to the relay with auth, hello, heartbeat,
 * exponential-backoff reconnect, unauthorized handling and call dispatch.
 */
import WebSocket from 'ws';
import os from 'node:os';
import {
  DEFAULTS, BRC_PROTOCOL_VERSION, parseMessage,
  type AgentMessage, type RelayMessage, type CallMessage, type DeviceInfo, type ToolDefinition,
} from 'brc-shared';

export interface WsClientOptions {
  relayUrl: string;          
  token: string;
  deviceId: string;
  name: string;
  agentVersion: string;
  coreVersion: string;
  tools: ToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>, client?: { name?: string; version?: string } | null) => Promise<unknown>;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
  /** Called when the relay rejects our token. Return true if the caller takes over (no further reconnects). */
  onUnauthorized?: () => Promise<boolean>;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff: number = DEFAULTS.reconnectMinMs;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | undefined;
  private lastUnauthorized = false;
  private unauthorizedCount = 0;
  private readonly log: NonNullable<WsClientOptions['log']>;
  readonly wsUrl: string;

  constructor(private readonly opts: WsClientOptions) {
    this.log = opts.log ?? (() => {});
    this.wsUrl = WsClient.toWsUrl(opts.relayUrl);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  static toWsUrl(relayUrl: string): string {
    const u = new URL(relayUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    if (!u.pathname.endsWith('/ws')) u.pathname = u.pathname.replace(/\/$/, '') + '/ws';
    return u.toString();
  }

  start(): void { this.stopped = false; this.stopPromise = undefined; this.connect(); }

  stop(): Promise<void> {
    return this.stopPromise ??= (async () => {
      this.stopped = true;
      this.clearPongTimer();
      clearTimeout(this.reconnectTimer ?? undefined);
      this.reconnectTimer = null;
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve, reject) => {
        let deadline: NodeJS.Timeout;
        const onClose = () => { clearTimeout(deadline); resolve(); };
        ws.once('close', onClose);
        deadline = setTimeout(() => {
          ws.off('close', onClose);
          ws.terminate();
          reject(new Error('Agent WebSocket did not close before the shutdown deadline.'));
        }, DEFAULTS.reconnectMinMs);
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, 'agent stopped');
      });
    })();
  }

  private connect(): void {
    if (this.stopped) return;
    this.log('info', `Connecting to ${this.wsUrl}`);
    const ws = new WebSocket(this.wsUrl, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'X-BRC-Protocol': String(BRC_PROTOCOL_VERSION) },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = DEFAULTS.reconnectMinMs;
      this.unauthorizedCount = 0;
      this.send({ type: 'hello', protocol: BRC_PROTOCOL_VERSION, device: this.deviceInfo(), tools: this.opts.tools });
      this.armPongTimer();
      this.log('info', 'Connected, hello sent');
    });

    ws.on('message', (data) => void this.onMessage(data as Buffer));

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) this.lastUnauthorized = true;
      this.log('error', `Relay refused connection: HTTP ${res.statusCode}`);
      ws.terminate();
    });

    ws.on('close', (code, reason) => {
      this.clearPongTimer();
      this.ws = null;
      if (this.stopped) return;
      if (code === 4401 || code === 4403 || this.lastUnauthorized) {
        this.lastUnauthorized = false;
        void this.handleUnauthorized(code);
        return;
      }
      this.log('warn', `Disconnected (${code} ${reason?.toString() || ''}); retry in ${this.backoff} ms`);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, DEFAULTS.reconnectMaxMs);
    });

    ws.on('error', (err) => this.log('error', `Socket error: ${err.message}`));
  }

  private async handleUnauthorized(code: number): Promise<void> {
    this.unauthorizedCount++;
    if (this.opts.onUnauthorized && this.unauthorizedCount <= 1) {
      this.stopped = true;
      const handled = await this.opts.onUnauthorized().catch((e) => { this.log('error', `re-pair failed: ${e instanceof Error ? e.message : String(e)}`); return false; });
      if (this.stopped && this.stopPromise) return;
      if (handled) return;
      this.stopped = false;
    }
    const wait = Math.min(DEFAULTS.reconnectMaxMs, 10_000 * this.unauthorizedCount);
    this.log('error', `Unauthorized (code ${code}); retry in ${wait} ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, wait);
  }

  private async onMessage(raw: Buffer): Promise<void> {
    const msg = parseMessage<RelayMessage>(raw);
    if (!msg) return this.log('warn', 'Dropped malformed frame');
    switch (msg.type) {
      case 'welcome':
        this.log('info', `Relay connected (protocol ${msg.protocol})`);
        return;
      case 'ping':
        this.armPongTimer();
        this.send({ type: 'pong', ts: msg.ts });
        return;
      case 'call':
        return this.handleCall(msg);
      case 'error':
        this.log('error', `Relay error ${msg.code}: ${msg.message}`);
        if (msg.fatal) {
          try { await this.stop(); }
          catch (error) { this.log('error', `WebSocket shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return;
    }
  }

  private async handleCall(msg: CallMessage): Promise<void> {
    this.log('debug', `call ${msg.id} ${msg.tool}`);
    try {
      const result = await this.opts.callTool(msg.tool, msg.args ?? {}, msg.client ?? null);
      this.send({ type: 'result', id: msg.id, result: result as never });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'result', id: msg.id, error: { code: 'AGENT_ERROR', message } });
    }
  }

  private send(msg: AgentMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private deviceInfo(): DeviceInfo {
    return {
      deviceId: this.opts.deviceId, name: this.opts.name, platform: process.platform, arch: process.arch,
      hostname: os.hostname(), agentVersion: this.opts.agentVersion, coreVersion: this.opts.coreVersion,
    };
  }

  private armPongTimer(): void {
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      this.log('warn', 'No ping from relay; forcing reconnect');
      this.ws?.terminate();
    }, DEFAULTS.pongTimeoutMs);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}
