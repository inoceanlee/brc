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

export interface AuthTokenPort {
  randomToken(bytes: number): string;
  sha256(raw: string): string;
}