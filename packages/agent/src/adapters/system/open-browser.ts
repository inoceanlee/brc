import { execFile, spawn } from 'child_process';
import os from 'os';
import { logToStderr } from '../telemetry/logger.js';

/**
 * Open a URL in the default browser (cross-platform)
 * Uses execFile/spawn with args array to avoid shell injection
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = os.platform();

  return new Promise((resolve, reject) => {
    const callback = (error: Error | null) => {
      if (error) {
        logToStderr('error', `Failed to open browser: ${error.message}`);
        reject(error);
      } else {
        logToStderr('info', `Opened browser to: ${url}`);
        resolve();
      }
    };

    switch (platform) {
      case 'darwin':
        execFile('open', [url], callback);
        break;
      case 'win32':

        spawn('cmd', ['/c', 'start', '', url], { shell: false, windowsHide: true }).on('close', (code) => {
          code === 0 ? resolve() : reject(new Error(`Exit code ${code}`));
        });
        break;
      default:
        execFile('xdg-open', [url], callback);
        break;
    }
  });
}

/**
 * Open the Desktop Commander welcome page
 */
export async function openWelcomePage(clientName?: string): Promise<void> {


  const url = 'https://desktopcommander.app/welcome/'
    + (clientName ? `?utm_source=${encodeURIComponent(clientName)}` : '');
  await openBrowser(url);
}
