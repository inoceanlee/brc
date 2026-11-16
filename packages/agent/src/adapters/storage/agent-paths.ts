import os from 'node:os';
import path from 'node:path';

export interface AgentPaths {
  root: string;
  configFile: string;
  credentialsFile: string;
  historyDirectory: string;
  usageFile: string;
  featureFlagFile: string;
  logsDirectory: string;
  legacyDirectory: string;
}

export function resolveAgentPaths(env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir(), platform = process.platform): AgentPaths {
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const root = p.resolve(env.BRC_DATA_ROOT || (windows
    ? p.join(env.LOCALAPPDATA || p.join(homeDirectory, 'AppData', 'Local'), 'BRC')
    : platform === 'darwin'
      ? p.join(homeDirectory, 'Library', 'Application Support', 'brc')
      : p.join(env.XDG_DATA_HOME || p.join(homeDirectory, '.local', 'share'), 'brc')));
  const stateDirectory = p.join(root, 'data', 'agent');
  return {
    root,
    configFile: p.resolve(env.BRC_CONFIG_FILE || p.join(root, 'config', 'brc.yaml')),
    credentialsFile: p.join(stateDirectory, 'device.json'),
    historyDirectory: stateDirectory,
    usageFile: p.join(stateDirectory, 'usage.json'),
    featureFlagFile: p.join(root, 'cache', 'agent', 'feature-flags.json'),
    logsDirectory: p.join(root, 'logs'),
    legacyDirectory: p.join(homeDirectory, '.brc'),
  };
}
