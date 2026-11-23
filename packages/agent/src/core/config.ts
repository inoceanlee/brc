import { DEFAULT_SETTINGS } from 'brc-shared';

export const AGENT_DEFAULTS = {
  fileReadLineLimit: DEFAULT_SETTINGS.agent.fileReadLineLimit,
  fileWriteLineLimit: DEFAULT_SETTINGS.agent.fileWriteLineLimit,
  historyFlushTimeoutMs: 5000,
  featureFlagFetchTimeoutMs: 3000,
  telemetryRequestTimeoutMs: 3000,
  pairingProgressIntervalMs: 30_000,
} as const;

export const DEFAULT_COMMAND_TIMEOUT = DEFAULT_SETTINGS.agent.commandTimeoutMs;
