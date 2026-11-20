export const ARCHITECTURE_BASELINE = Object.freeze(new Set([
  'agent/core/ui/file-preview/shared/preview-file-types.ts: core imports external dependency path',
  'cli/adapters/storage/cleanup.ts: nested service construction ProcessManager@inspectServiceRecords:manager',
  'shared/diagnostics/adapters/resources-node.ts: nested service construction NodeResourceSampler@sampleNodeResources:sampler',
]));

export function compareWithBaseline(actual, baseline = ARCHITECTURE_BASELINE) {
  const found = new Set(actual);
  return {
    newViolations: actual.filter((entry) => !baseline.has(entry)),
    staleBaseline: [...baseline].filter((entry) => !found.has(entry)),
  };
}
