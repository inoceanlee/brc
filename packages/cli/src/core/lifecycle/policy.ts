import type { ManagedServiceName, ServiceStatus } from './ports.js';

/** Services start in dependency order and stop in reverse. */
export const SERVICE_START_ORDER: readonly ManagedServiceName[] = ['relay', 'traefik', 'agent'];


export function isStaleDegraded(status: Pick<ServiceStatus, 'state' | 'recoverable'>): boolean {
  return status.state === 'degraded' && status.recoverable === true;
}

export function isStartable(status: Pick<ServiceStatus, 'state' | 'recoverable'>): boolean {
  return status.state === 'stopped';
}

export function isRecoverableForStart(status: Pick<ServiceStatus, 'state' | 'recoverable'>): boolean {
  return isStartable(status) || isStaleDegraded(status);
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
