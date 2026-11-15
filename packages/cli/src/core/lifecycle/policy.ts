import type { ManagedServiceName, ServiceStatus } from './ports.js';

/** Services start in dependency order and stop in reverse. */
export const SERVICE_START_ORDER: readonly ManagedServiceName[] = ['relay', 'traefik', 'agent'];

const STALE_DEGRADED_MARKERS = [
  'Process identity changed',
  'malformed',
  'incomplete',
  'belongs to another workspace',
  'JSON',
  'Recorded process has exited',
] as const;

/**
 * A degraded record left by a previous boot, a different workspace or a
 * corrupted file is treated as stopped, so a fresh start can safely rewrite
 * configuration instead of refusing to start.
 */
export function isStaleDegraded(status: Pick<ServiceStatus, 'state' | 'detail'>): boolean {
  return status.state === 'degraded'
    && STALE_DEGRADED_MARKERS.some((marker) => status.detail.includes(marker));
}

export function isStartable(status: Pick<ServiceStatus, 'state' | 'detail'>): boolean {
  return status.state === 'stopped' || isStaleDegraded(status);
}

export function isActive(status: Pick<ServiceStatus, 'state'>): boolean {
  return status.state === 'running' || status.state === 'pairing';
}

/**
 * A partially running set cannot be started safely: starting would leave the
 * running instance on old configuration. Restart is the explicit escape.
 */
export function startRejection(statuses: readonly ServiceStatus[]): string | undefined {
  if (statuses.some(isActive) && statuses.some((status) => isStartable(status))) {
    return 'Cannot start a partially running service set; run brc restart to apply configuration safely.';
  }
  return undefined;
}

export function shouldWriteTraefikConfig(statuses: readonly ServiceStatus[]): boolean {
  return statuses.every((status) => isStartable(status));
}
