export const ARCHITECTURE_BASELINE = Object.freeze(new Set([
  'cli/commands/diagnostics.ts: nested service construction SqliteDiagnosticsStore@readLatestTrace:store',
]));

export function compareWithBaseline(actual, baseline = ARCHITECTURE_BASELINE) {
  const found = new Set(actual);
  return {
    newViolations: actual.filter((entry) => !baseline.has(entry)),
    staleBaseline: [...baseline].filter((entry) => !found.has(entry)),
  };
}
