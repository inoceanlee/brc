import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { mdToPdf } from 'md-to-pdf';
import type { PageRange } from './lib/pdf2md.js';
import { PdfParseResult, pdf2md } from './lib/pdf2md.js';
import { resolveAgentPaths } from '../../storage/agent-paths.js';
import type { TextLogPort } from 'brc-shared';
import { textLogToStderr } from '../../telemetry/logger.js';

let pdfLogPort: TextLogPort = textLogToStderr();

export function setPdfLogPort(port: TextLogPort): void {
    pdfLogPort = port;
}

const isUrl = (source: string): boolean =>
    source.startsWith('http://') || source.startsWith('https://');


let cachedChromePath: string | undefined | null = null; 
let chromeCheckPromise: Promise<string | undefined> | null = null;

interface CachedPuppeteerChrome {
    executablePath: string;
}

/**
 * Get Desktop Commander's private Puppeteer cache directory.
 */
function getPuppeteerCacheDir(): string {
    return join(resolveAgentPaths().root, 'cache', 'agent', 'puppeteer-cache');
}

/**
 * Get the cache path where Puppeteer stores Chrome for Testing builds.
 */
function getPuppeteerChromeDir(cacheDir = getPuppeteerCacheDir()): string {
    return join(cacheDir, 'chrome');
}

/**
 * Find the platform-specific executable within a cached Chrome build directory.
 */
function getChromeExecutablePath(chromeDir: string, version: string): string | undefined {
    const chromePath = process.platform === 'win32'
        ? join(chromeDir, version, 'chrome-win64', 'chrome.exe')
        : process.platform === 'darwin'
        ? join(chromeDir, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        : join(chromeDir, version, 'chrome-linux64', 'chrome');

    if (existsSync(chromePath)) {
        return chromePath;
    }


    if (process.platform === 'darwin') {
        const armPath = join(chromeDir, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(armPath)) {
            return armPath;
        }
    }

    return undefined;
}

/**
 * Resolve the cached Chrome build directory that owns an executable path.
 */
function getCachedChromeBuildDir(chromeDir: string, executablePath: string): string | undefined {
    const relativePath = relative(chromeDir, executablePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        return undefined;
    }

    const [buildDir] = relativePath.split(sep);
    return buildDir ? join(chromeDir, buildDir) : undefined;
}

/**
 * Find Chrome in puppeteer's cache directory
 * Returns the executable path if found, undefined otherwise
 */
export function findPuppeteerChrome(cacheDir = getPuppeteerCacheDir()): CachedPuppeteerChrome | undefined {
    const chromeDir = getPuppeteerChromeDir(cacheDir);

    if (!existsSync(chromeDir)) {
        return undefined;
    }

    try {

        const versions = readdirSync(chromeDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

        for (const version of versions) {
            const executablePath = getChromeExecutablePath(chromeDir, version);
            if (executablePath) {
                return { executablePath };
            }
        }
    } catch {

    }

    return undefined;
}

/**
 * Remove stale Puppeteer Chrome builds while preserving the active build.
 */
export async function pruneOldPuppeteerChromeBuilds(activeExecutablePath: string, cacheDir = getPuppeteerCacheDir()): Promise<void> {
    const chromeDir = getPuppeteerChromeDir(cacheDir);
    const activeBuildDir = getCachedChromeBuildDir(chromeDir, activeExecutablePath);
    if (!activeBuildDir) {
        return;
    }

    let entries;
    try {
        entries = await fs.readdir(chromeDir, { withFileTypes: true });
    } catch {
        return;
    }

    await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
            const buildDir = join(chromeDir, entry.name);
            if (resolve(buildDir) === resolve(activeBuildDir)) {
                return;
            }

            try {
                await fs.rm(buildDir, { recursive: true, force: true });
            } catch (error) {
                pdfLogPort.warning(`Failed to remove old Chrome cache build at ${buildDir}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }));
}

/**
 * Find system-installed Chrome/Chromium browser
 * Returns the executable path if found, undefined otherwise
 */
function findSystemChrome(): string | undefined {
    const paths: string[] = process.platform === 'win32' 
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ]
        : [

            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];

    return paths.find(p => existsSync(p));
}

/**
 * Download and install Chrome using @puppeteer/browsers
 * Returns the executable path after installation
 */
async function installChrome(): Promise<CachedPuppeteerChrome> {

    const { install, Browser, detectBrowserPlatform, resolveBuildId } = await import('@puppeteer/browsers' as string);

    const cacheDir = getPuppeteerCacheDir();
    const platform = detectBrowserPlatform()!;
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');

    pdfLogPort.info('Downloading Chrome for PDF generation (this may take a few minutes)...');
    await fs.mkdir(cacheDir, { recursive: true });

    const installedBrowser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir,
        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
            const percent = Math.round((downloadedBytes / totalBytes) * 100);
            process.stderr.write(`\rDownloading Chrome: ${percent}%`);
        },
    });

    pdfLogPort.info('Chrome download complete.');

    return {
        executablePath: installedBrowser.executablePath,
    };
}

/**
 * Find or install Chrome for PDF generation
 * Priority: Puppeteer cache, then system Chrome, then install Chrome
 * Results are cached to avoid repeated lookups
 */
async function getChromePath(): Promise<string | undefined> {

    if (cachedChromePath !== null) {
        return cachedChromePath;
    }


    if (chromeCheckPromise) {
        return chromeCheckPromise;
    }


    chromeCheckPromise = (async () => {

        const cachedChrome = findPuppeteerChrome();
        if (cachedChrome) {
            await pruneOldPuppeteerChromeBuilds(cachedChrome.executablePath);
            cachedChromePath = cachedChrome.executablePath;
            return cachedChrome.executablePath;
        }


        const systemChrome = findSystemChrome();
        if (systemChrome) {
            cachedChromePath = systemChrome;
            return systemChrome;
        }


        try {
            const installedChrome = await installChrome();
            await pruneOldPuppeteerChromeBuilds(installedChrome.executablePath);
            cachedChromePath = installedChrome.executablePath;
            return installedChrome.executablePath;
        } catch (error) {
            pdfLogPort.error(`Failed to install Chrome: ${error instanceof Error ? error.message : String(error)}`);
            cachedChromePath = undefined;
            return undefined;
        }
    })();

    const result = await chromeCheckPromise;
    chromeCheckPromise = null;
    return result;
}

/**
 * Preemptively ensure Chrome is available for PDF generation.
 * Call this at server startup to trigger download in background if needed.
 * Returns immediately, download happens in background.
 */
export function ensureChromeAvailable(): void {

    getChromePath().catch((error) => {
        pdfLogPort.error(`Background Chrome check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function loadPdfToBuffer(source: string): Promise<Buffer | ArrayBuffer> {
    if (isUrl(source)) {
        const response = await fetch(source);
        return await response.arrayBuffer();
    } else {
        return await fs.readFile(source);
    }
}

/**
 * Convert PDF to Markdown using @opendocsg/pdf2md
 */
export async function parsePdfToMarkdown(source: string, pageNumbers: number[] | PageRange = []): Promise<PdfParseResult> {
    try {
        const data = await loadPdfToBuffer(source);


        return await pdf2md(new Uint8Array(data), pageNumbers, pdfLogPort);

    } catch (error) {
        pdfLogPort.error(`Error converting PDF to Markdown: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

export async function parseMarkdownToPdf(markdown: string, options: any = {}): Promise<Buffer> {
    try {

        const chromePath = await getChromePath();

        if (chromePath) {
            options = {
                ...options,
                launch_options: {
                    ...options.launch_options,
                    executablePath: chromePath,
                }
            };
        }

        const pdf = await mdToPdf({ content: markdown }, options);

        return pdf.content;
    } catch (error) {

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Could not find Chrome')) {
            throw new Error(
                'PDF generation requires Chrome or Chromium browser. ' +
                'Please install Google Chrome from https://www.google.com/chrome/ ' +
                'or Chromium, then try again.'
            );
        }
        pdfLogPort.error(`Error creating PDF: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}
