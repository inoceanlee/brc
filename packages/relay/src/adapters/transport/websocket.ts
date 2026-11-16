import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { RelayStorePort } from '../../core/auth/ports.js';
import type { DeviceHub } from './device-hub.js';

export function registerDeviceSocket(
  http: HttpServer,
  wss: WebSocketServer,
  hub: DeviceHub,
  store: RelayStorePort,
  publicUrl: string,
  log: (level: string, message: string) => void,
): void {
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', publicUrl);
    if (url.pathname !== '/ws') return socket.destroy();
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7).trim() : url.searchParams.get('token');
    const device = token ? store.getDeviceByToken(token) : undefined;
    if (!device || !store.getUser(device.user_id)) {
      log('warn', `agent auth failed from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.attach(ws, device.user_id, device.device_id);
      store.touchDevice(device.device_id);
    });
  });
}