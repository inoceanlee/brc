/**
 * BRC agent device pairing (OAuth device-authorization style) + credential persistence.
 * Credentials: BRC data root / data / agent / device.json (mode 0600)
 */
import { randomUUID } from 'node:crypto';
import type { DeviceCredentials } from '../storage/credential-store.js';

export type { DeviceCredentials } from '../storage/credential-store.js';


export interface PairOptions {
  relayUrl: string;
  name: string;
  deviceId?: string;
  openBrowser?: boolean;
  log: (msg: string) => void;
  signal?: AbortSignal;
  credentials: {
    load(): DeviceCredentials | null;
    save(credentials: DeviceCredentials): void;
    filename: string;
  };
}

interface StartResponse { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
interface PollResponse { device_token?: string; device_id?: string; error?: string; interval?: number }

type PairingState =
  | { kind: 'polling'; interval: number }
  | { kind: 'approved'; deviceId: string; deviceToken: string }
  | { kind: 'failed'; message: string };

function advancePairing(state: Extract<PairingState, { kind: 'polling' }>, response: PollResponse): PairingState {
  if (response.device_token && response.device_id) {
    return { kind: 'approved', deviceId: response.device_id, deviceToken: response.device_token };
  }
  switch (response.error) {
    case 'authorization_pending': return state;
    case 'slow_down': return { kind: 'polling', interval: state.interval + 5000 };
    case 'access_denied': return { kind: 'failed', message: 'pairing denied by the relay owner' };
    case 'expired_token': return { kind: 'failed', message: 'pairing code expired; start the agent again' };
    default: return { kind: 'failed', message: `pairing failed: ${response.error ?? 'unknown error'}` };
  }
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Pairing aborted.'));
  const abort = () => { clearTimeout(timer); reject(new Error('Pairing aborted.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

/** Runs the pairing flow until approved, denied or expired. Returns saved credentials. */
export async function pairDevice(opts: PairOptions): Promise<DeviceCredentials> {
  if (opts.signal?.aborted) throw new Error('Pairing aborted.');
  if (opts.credentials.load()) throw new Error('agent already paired; clear credentials before pairing a different device');
  const base = opts.relayUrl.replace(/\/$/, '');
  const deviceId = opts.deviceId ?? randomUUID();
  const { status, json: start } = await postJson<StartResponse>(`${base}/device/start`, { client_name: opts.name }, opts.signal);
  if (status !== 200 || !start.device_code) throw new Error(`relay rejected pairing start (${status})`);

  opts.log('');
  opts.log('Pairing required. Open this URL and enter the code:');
  opts.log(`   ${start.verification_uri}`);
  opts.log(`   code: ${start.user_code}   (expires in ${Math.round(start.expires_in / 60)} min)`);
  opts.log('');
  if (opts.openBrowser !== false) {
    try { const { default: open } = await import('open'); await open(start.verification_uri_complete); } catch { }
  }

  let state: Extract<PairingState, { kind: 'polling' }> = { kind: 'polling', interval: Math.max(2, start.interval ?? 5) * 1000 };
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(state.interval, opts.signal);
    const { json } = await postJson<PollResponse>(`${base}/device/poll`, {
      device_code: start.device_code, device_id: deviceId, name: opts.name, platform: `${process.platform}/${process.arch}`,
    }, opts.signal);
    const next = advancePairing(state, json);
    if (next.kind === 'approved') {
      const creds: DeviceCredentials = { relayUrl: base, deviceId: next.deviceId, deviceToken: next.deviceToken, name: opts.name, pairedAt: new Date().toISOString() };
      if (opts.signal?.aborted) throw new Error('Pairing aborted.');
      opts.credentials.save(creds);
      opts.log(`Paired as "${opts.name}" [${next.deviceId}]; credentials saved to ${opts.credentials.filename}`);
      return creds;
    }
    if (next.kind === 'failed') throw new Error(next.message);
    state = next;
  }
  throw new Error('pairing code expired; start the agent again');
}
