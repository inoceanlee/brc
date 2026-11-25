import type { ManagedServiceName, ServiceStatus } from './ports.js';

/** Services start in dependency order and stop in reverse. */
export const SERVICE_START_ORDER: readonly ManagedServiceName[] = ['relay', 'traefik', 'agent'];


export function isStaleDegraded(status: Pick<ServiceStatus, 'state' | 'recoverable'>): boolean {
  return status.state === 'degraded' && status.recoverable === true;
}

export interface ReusedPidEvidence {
  samePid: boolean;
  creationTimeChanged: boolean;
  storedCommandHasManagedId: boolean;
  storedCommandHasEntrypoint: boolean;
  currentCommandDiffers: boolean;
  currentCommandHasNoManagedId: boolean;
}

export function isReusedPidRecord(facts: ReusedPidEvidence): boolean {
  return facts.samePid
    && facts.creationTimeChanged
    && facts.storedCommandHasManagedId
    && facts.storedCommandHasEntrypoint
    && facts.currentCommandDiffers
    && facts.currentCommandHasNoManagedId;
}

export function isStartable(status: Pick<ServiceStatus, 'state'>): boolean {
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
  if (statuses.some(isActive) && statuses.some(isRecoverableForStart)) {
    return 'Cannot start a partially running service set; run brc restart to apply configuration safely.';
  }
  return undefined;
}

export function shouldWriteTraefikConfig(statuses: readonly ServiceStatus[]): boolean {
  return statuses.every(isRecoverableForStart);
}
