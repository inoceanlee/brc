import { resolveSettings, type BrcSettings } from 'brc-shared';
import { DEFAULT_ADMIN_USER } from '../../core/auth/policy.js';

export interface RelayConfig {
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean | number | string;
  dbFile: string;
  sessionSecret: string;
  adminUser: string;
  adminPassword: string;
  relayVersion: string;
  audit: BrcSettings['audit'];
}

export function parseTrustProxy(value: string | undefined): RelayConfig['trustProxy'] {
  if (value === undefined || value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1' || value === 'loopback') return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const { settings } = resolveSettings({ version: 1 }, env);
  const port = env.PORT === undefined ? settings.services.relayPort : Number(env.PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const publicUrl = env.PUBLIC_URL ?? settings.services.publicUrl ?? '';
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    publicUrl: (publicUrl || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    dbFile: env.BRC_DB ?? 'data/relay.sqlite',
    sessionSecret: env.BRC_SESSION_SECRET ?? '',
    adminUser: env.BRC_ADMIN_USER ?? DEFAULT_ADMIN_USER,
    adminPassword: env.BRC_ADMIN_PASSWORD ?? '',
    relayVersion: env.BRC_PRODUCT_VERSION ?? 'unknown',
    audit: settings.audit,
  };
}