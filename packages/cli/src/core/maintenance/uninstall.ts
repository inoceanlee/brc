import type { PackageRemovalResult } from './ports.js';

export function packageRemovalStatus(result: PackageRemovalResult | void): 'scheduled' | 'removed' {
  return result?.scheduled ? 'scheduled' : 'removed';
}

export function uninstallCompletionMessage(result: PackageRemovalResult | void, hasResiduals: boolean): string {
  const packageMessage = result?.scheduled && result.reportPath
    ? `BRC package removal scheduled; completion report: ${result.reportPath}`
    : 'BRC package removed.';
  return hasResiduals
    ? `${packageMessage} Review the residual paths above.`
    : `BRC data removed. ${packageMessage}`;
}
