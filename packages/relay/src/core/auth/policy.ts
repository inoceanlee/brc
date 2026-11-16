export const SCOPES = ['mcp:tools'];
export const AUTH_CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
export function grantedScopes(granted: readonly string[], requested?: readonly string[]): string[] {
  return requested?.length ? requested.filter((scope) => granted.includes(scope)) : [...granted];
}
export const DEFAULT_ADMIN_USER = 'admin';
