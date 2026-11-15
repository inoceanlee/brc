import path from 'node:path';

export function isAllowedPort(port, selected) {
  return ![3000, 13001, 13002, ...selected].includes(port);
}

export function summarize(samplesMs) {
  if (samplesMs.length !== 5) throw new Error('Expected exactly five samples.');
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { samplesMs, medianMs: sorted[2], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export function isolatedEnvironment(source, root, ports) {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'SYSTEMDRIVE']);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    BRC_DATA_ROOT: root,
    BRC_NO_BROWSER: '1',
    BRC_RELAY_PORT: String(ports[0]),
    BRC_TRAEFIK_PORT: String(ports[1]),
    BRC_TRAEFIK_HEALTH_PORT: String(ports[2]),
  };
}
