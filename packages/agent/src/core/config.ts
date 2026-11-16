import { DEFAULT_SETTINGS } from 'brc-shared';

export const AGENT_DEFAULTS = {
  fileReadLineLimit: DEFAULT_SETTINGS.agent.fileReadLineLimit,
  fileWriteLineLimit: DEFAULT_SETTINGS.agent.fileWriteLineLimit,
  historyFlushTimeoutMs: 5000,
} as const;

export const DEFAULT_COMMAND_TIMEOUT = DEFAULT_SETTINGS.agent.commandTimeoutMs;
