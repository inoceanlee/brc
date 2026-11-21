import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

export const RELEASE_CONFIG = Object.freeze({
  packageName: '@inoceanlee/brc',
  tagPrefix: 'brc-v',
  registry: 'https://registry.npmjs.org/',
  artifactDirectory: path.join(workspaceRoot, 'artifacts', 'releases'),
  validationNames: Object.freeze(['package', 'e2e', 'dryRun']),
  progressIntervalMs: 120,
  progressHeartbeatMs: 15000,
  registryAttempts: 240,
  registryPollMs: 5000,
  keepValidatedArtifacts: 3,
  stagePruneRules: Object.freeze({
    sourceMaps: /\.map$/i,
    typescript: /\.(?:d\.ts|ts)$/i,
    testDirectories: /^(?:test|tests|__tests__)(?:\/|$)/i,
    exampleDirectories: /^(?:example|examples|benchmark|benchmarks)(?:\/|$)/i,
    documentationDirectories: /^docs(?:\/|$)/i,
    documentationFiles: /^(?:readme|changelog|history|contributing|code_of_conduct|authors|contributors|security)\.(?:md|txt|html)$/i,
    runtimeAssets: /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|png|jpe?g|gif|webp|avif|bmp|tiff?|ico|svg|heic|md)$/i,
  }),
});
