import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrcPaths } from '../../config/paths.js';
import type { BrcSettings } from '../../config/settings.js';
import { readProductVersion } from '../../config/product.js';
import type { ManagedServiceSpec } from '../../core/lifecycle/ports.js';

function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of [
    'BRC_DATA_ROOT', 'BRC_HOME', 'BRC_CONFIG_FILE', 'BRC_DB', 'BRC_RELAY', 'BRC_NAME', 'BRC_TOKEN', 'BRC_DEVICE_ID', 'BRC_LOG_FILE',
    'BRC_TRAEFIK_ROOT', 'BRC_TRAEFIK_CONFIG_DIR', 'BRC_TRAEFIK_PORT', 'BRC_TRAEFIK_HEALTH_PORT', 'BRC_RELAY_PORT', 'BRC_LOG_ROTATE_MIB',
    'BRC_ADMIN_USER', 'BRC_ADMIN_PASSWORD', 'BRC_SESSION_SECRET', 'BRC_PRODUCT_VERSION', 'PORT', 'HOST', 'PUBLIC_URL', 'TRUST_PROXY',
    'BRC_DIAGNOSTICS_ENABLED', 'BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS', 'BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS',
    'BRC_DIAGNOSTICS_MAX_RECORD_BYTES', 'BRC_DIAGNOSTICS_RETENTION_DAYS', 'BRC_DIAGNOSTICS_DIR', 'BRC_INSTANCE_ID',
  ]) delete env[name];
  return env;
}

export function diagnosticEnvironment(
  settings: Readonly<BrcSettings>,
  paths: BrcPaths,
): NodeJS.ProcessEnv {
  return {
    BRC_DIAGNOSTICS_ENABLED: String(settings.diagnostics.enabled),
    BRC_DIAGNOSTICS_RESOURCE_SAMPLE_MS: String(settings.diagnostics.resourceSampleMs),
    BRC_DIAGNOSTICS_FUNCTION_SNAPSHOT_MS: String(settings.diagnostics.functionSnapshotMs),
    BRC_DIAGNOSTICS_MAX_RECORD_BYTES: String(settings.diagnostics.maxRecordBytes),
    BRC_DIAGNOSTICS_RETENTION_DAYS: String(settings.diagnostics.retentionDays),
    BRC_DIAGNOSTICS_DIR: paths.diagnostics,
  };
}


export function createDefaultServices(
  paths: BrcPaths,
  settings: Readonly<BrcSettings>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): ManagedServiceSpec[] {
  const cliDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const packedRelayEntry = path.resolve(cliDist, 'services/relay/cli.js');
  const packedAgentEntry = path.resolve(cliDist, 'services/agent/cli.js');
  const isStandalonePackage = existsSync(packedRelayEntry) && existsSync(packedAgentEntry);
  const workspaceRoot = isStandalonePackage ? path.resolve(cliDist, '..') : path.resolve(cliDist, '../../..');
  const cliEntry = path.resolve(cliDist, 'cli.js');
  const productVersion = readProductVersion();
  const relayEntry = isStandalonePackage ? packedRelayEntry : path.resolve(cliDist, '../../relay/dist/cli.js');
  const agentEntry = isStandalonePackage ? packedAgentEntry : path.resolve(cliDist, '../../agent/dist/cli.js');
  const { relayPort: relay, proxyPort: proxy, healthPort: health } = settings.services;
  const proxyUrl = `http://127.0.0.1:${proxy}`;
  const baseEnv = { ...childEnvironment(parentEnv), BRC_PRODUCT_VERSION: productVersion };
  const relayEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...diagnosticEnvironment(settings, paths),
    BRC_LOG_ROTATE_MIB: String(settings.logs.rotateMiB),
    BRC_AUDIT_RETENTION_DAYS: String(settings.audit.retentionDays),
    BRC_AUDIT_MAX_ENTRIES: String(settings.audit.maxEntries),
    HOST: '127.0.0.1',
    PORT: String(relay),
    PUBLIC_URL: settings.services.publicUrl || proxyUrl,
    TRUST_PROXY: 'loopback',
    BRC_DB: path.join(paths.data, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(paths.logs, 'relay.log'),
  };
  const traefikEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...diagnosticEnvironment(settings, paths),
    BRC_LOG_ROTATE_MIB: String(settings.logs.rotateMiB),
    BRC_DATA_ROOT: paths.root,
    BRC_RUNTIME_STARTUP_TIMEOUT_MS: String(settings.runtime.startupTimeoutMs),
    BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS: String(settings.runtime.shutdownTimeoutMs),
    BRC_TRAEFIK_ROOT: paths.traefik,
    BRC_TRAEFIK_CONFIG_DIR: path.join(paths.traefik, 'config'),
    BRC_TRAEFIK_PORT: String(proxy),
    BRC_TRAEFIK_HEALTH_PORT: String(health),
    BRC_RELAY_PORT: String(relay),
    BRC_LOG_FILE: path.join(paths.logs, 'traefik.log'),
  };
  const agentEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...diagnosticEnvironment(settings, paths),
    BRC_LOG_ROTATE_MIB: String(settings.logs.rotateMiB),
    BRC_DATA_ROOT: paths.root,
    BRC_CONFIG_FILE: path.join(paths.config, 'brc.yaml'),
    BRC_LOG_FILE: path.join(paths.logs, 'agent.log'),
    BRC_RELAY: proxyUrl,
    BRC_NAME: parentEnv.BRC_NAME ?? os.hostname(),
    BRC_DEBUG: parentEnv.BRC_DEBUG,
  };

  return [
    { name: 'relay', entrypoint: relayEntry, workspaceRoot, cwd: workspaceRoot, env: relayEnv },
    { name: 'traefik', entrypoint: cliEntry, args: ['--run-traefik'], workspaceRoot, cwd: workspaceRoot, env: traefikEnv },
    { name: 'agent', entrypoint: agentEntry, workspaceRoot, cwd: workspaceRoot, env: agentEnv },
  ];
}
