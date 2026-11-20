import type { CleanupResult } from 'brc-shared';
import type { BrcPaths } from '../../config/paths.js';

export interface CleanupPort {
  clean(paths: BrcPaths, signal?: AbortSignal): Promise<CleanupResult>;
}

export interface PackageRemovalResult {
  scheduled: boolean;
  reportPath?: string;
}
