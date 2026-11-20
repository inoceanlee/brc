export type ConfigFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'null';

export type ConfigFieldDefinition = {
  label: string;
  description: string;
  valueType: ConfigFieldValueType;
};


export const CONFIG_FIELD_DEFINITIONS = {
  blockedCommands: {
    label: 'Blocked Commands',
    description: 'This is your personal safety blocklist. If a command appears here, Desktop Commander will refuse to run it even if a prompt asks for it. Add risky commands you never want executed by mistake.',
    valueType: 'array',
  },
  allowedDirectories: {
    label: 'Allowed Folders',
    description: 'These are the folders Desktop Commander is allowed to read and edit. Think of this as a permission list. Keeping it small is safer. If this list is empty, Desktop Commander can access your entire filesystem.',
    valueType: 'array',
  },
  defaultShell: {
    label: 'Default Shell',
    description: 'This is the shell used for new command sessions (for example /bin/bash or /bin/zsh). Only change this if you know your environment requires a specific shell.',
    valueType: 'string',
  },
  telemetryEnabled: {
    label: 'Anonymous Telemetry',
    description: 'When on, Desktop Commander sends anonymous usage information that helps improve product quality. When off, no telemetry data is sent.',
    valueType: 'boolean',
  },
  fileReadLineLimit: {
    label: 'File Read Limit',
    description: 'Maximum number of lines returned from a file in one read action. Lower numbers keep responses short and safer; higher numbers return more text at once.',
    valueType: 'number',
  },
  fileWriteLineLimit: {
    label: 'File Write Limit',
    description: 'Maximum number of lines that can be written in one edit operation. This helps prevent accidental oversized writes and keeps file changes predictable.',
    valueType: 'number',
  },
} as const satisfies Record<string, ConfigFieldDefinition>;

export type ConfigFieldKey = keyof typeof CONFIG_FIELD_DEFINITIONS;

export const CONFIG_FIELD_KEYS = Object.keys(CONFIG_FIELD_DEFINITIONS) as ConfigFieldKey[];

export function isConfigFieldKey(value: string): value is ConfigFieldKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_FIELD_DEFINITIONS, value);
}

export function parseEditableValue(key: ConfigFieldKey, raw: unknown): string | number | boolean | string[] {
  if (!isConfigFieldKey(key)) throw new Error(`Key "${key}" is not configurable`);
  const type = CONFIG_FIELD_DEFINITIONS[key].valueType;
  if (type === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
  } else if (type === 'number') {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  } else if (type === 'string') {
    if (typeof raw === 'string' && raw.trim()) return raw;
  } else if (type === 'array') {
    let value = raw;
    if (typeof value === 'string') {
      const input = value;
      try {
        const parsed: unknown = JSON.parse(input);
        value = Array.isArray(parsed) ? parsed : [typeof parsed === 'string' ? parsed : input];
      } catch {
        value = [input];
      }
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value];
  }
  throw new Error(`Invalid value for ${key}`);
}
