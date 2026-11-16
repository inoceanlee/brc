export interface AuthUser { id: string }
export interface AuthClient { client_id: string; client_secret: string | null; metadata: string; created_at: number }
export interface AuthCode {
  code: string; client_id: string; user_id: string; code_challenge: string;
  redirect_uri: string; scopes: string; resource: string | null; expires_at: number;
}
export interface AuthToken {
  token_hash: string; kind: 'access' | 'refresh'; client_id: string;
  user_id: string; scopes: string; resource: string | null; expires_at: number | null;
  created_at: number; revoked: number;
}
export interface AuthApiKey { user_id: string; name: string; prefix: string }

export interface AuthStorePort {
  getClient(clientId: string): AuthClient | undefined;
  insertClient(client: AuthClient): void;
  getUser(id: string): AuthUser | undefined;
  insertAuthCode(code: AuthCode): void;
  peekAuthCode(code: string): AuthCode | undefined;
  takeAuthCode(code: string): AuthCode | undefined;
  insertToken(token: AuthToken): void;
  getToken(raw: string, kind: 'access' | 'refresh'): AuthToken | undefined;
  revokeToken(raw: string): void;
  getApiKey(raw: string): AuthApiKey | undefined;
}

export interface RelayDevice {
  device_id: string; user_id: string; name: string; token_hash: string;
  platform: string | null; created_at: number; last_seen: number | null; paused: number;
}
export interface RelayDeviceCode {
  device_code: string; user_code: string; client_name: string; user_id: string | null;
  approved: number; denied: number; device_id: string | null; expires_at: number; created_at: number;
}
export interface RelayAudit {
  id: number; ts: number; user_id: string | null; device_id: string | null;
  client: string | null; tool: string; args_hash: string | null; ok: number; ms: number | null; error: string | null;
}

export interface RelayStorePort extends AuthStorePort {
  getUserByName(username: string): { id: string; password_hash: string } | undefined;
  getDevice(deviceId: string): RelayDevice | undefined;
  getDeviceByToken(token: string): RelayDevice | undefined;
  listDevices(userId: string): RelayDevice[];
  issueDeviceToken(deviceId: string, userId: string, name: string, platform: string | null): string;
  touchDevice(deviceId: string): void;
  setDevicePaused(deviceId: string, paused: boolean): void;
  deleteDevice(deviceId: string): void;
  renameDevice(deviceId: string, name: string): void;
  createDeviceCode(clientName: string, ttlMs: number): RelayDeviceCode;
  getDeviceCode(deviceCode: string): RelayDeviceCode | undefined;
  getDeviceCodeByUserCode(userCode: string): RelayDeviceCode | undefined;
  approveDeviceCode(deviceCode: string, userId: string, deviceId: string): void;
  denyDeviceCode(deviceCode: string): void;
  deleteDeviceCode(deviceCode: string): void;
  audit(row: Omit<RelayAudit, 'id'>): void;
  recentAudit(userId: string, limit?: number): RelayAudit[];
  auditStats(userId: string): { total: number; failed: number; last24h: number };
  listClients(): AuthClient[];
  deleteClient(clientId: string): void;
  createApiKey(userId: string, name: string): { raw: string; prefix: string };
  listApiKeys(userId: string): { prefix: string; name: string; created_at: number; last_used: number | null }[];
  revokeApiKey(userId: string, prefix: string): void;
}

export interface AuthTokenPort {
  randomToken(bytes: number): string;
  sha256(raw: string): string;
}