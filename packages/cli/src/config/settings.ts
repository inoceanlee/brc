export {
  BRC_SETTING_KEYS,
  SETTING_ENVIRONMENT_KEYS,
  HEALTH_REQUEST_TIMEOUT_MS,
  HEALTH_RETRY_COUNT,
  IDENTITY_INSPECTION_RETRY_COUNT,
  TRAEFIK_RELEASE_LOOKUP_ATTEMPTS,
  TRAEFIK_RELEASE_RETRY_DELAY_MS,
  DEFAULT_SETTINGS,
  withSettingValue,
  resolveSettings,
  parseSettingArgument,
  isBrcSettingKey,
} from 'brc-shared';

export type {
  BrcSettings,
  BrcSettingValues,
  BrcSettingKey,
  BrcSettingSource,
  BrcSettingSources,
  ResolvedSettings,
} from 'brc-shared';
