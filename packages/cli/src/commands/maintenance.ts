import type { BrcPaths } from '../config/paths.js';
import { showLogs, type LogComponent } from '../maintenance/logs.js';
import { confirmBrcUninstall, detectGlobalBrcPackageManager, removeGlobalBrcPackage, uninstallBrc } from '../maintenance/uninstall.js';

export function createMaintenanceCommands(
  paths: BrcPaths,
  write: (message: string) => void,
  writeError: (message: string) => void,
  dependencies: { stopServices: (signal?: AbortSignal) => Promise<void>; confirm?: (root: string) => Promise<boolean> },

) {
  return {
    logs: (component?: LogComponent) => showLogs(paths, component, write, writeError),
    uninstall: ({ yes, structuredOutput, signal }: { yes: boolean; structuredOutput?: boolean; signal?: AbortSignal }, clean: () => Promise<void>) => uninstallBrc({
      yes,
      structuredOutput,
      stopServices: () => dependencies.stopServices(signal),
      paths,
      confirm: dependencies.confirm ?? confirmBrcUninstall,
      clean,
      preparePackageRemoval: detectGlobalBrcPackageManager,
      removePackage: removeGlobalBrcPackage,
      write,
    }),
  };
}
