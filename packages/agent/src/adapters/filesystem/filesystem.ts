import fs from "fs/promises";
import path from "path";
import os from 'os';
import fetch from 'cross-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentConfigManager } from '../storage/config-manager.js';
import { withTimeout, runWithAbortableTimeout } from '../system/timeout.js';
import type { Capture } from '../telemetry/capture.js';
import type { SearchManager } from '../system/search-manager.js';
import { AGENT_DEFAULTS } from '../../core/config.js';
import { TextFileHandler, type FileHandlerFactory } from './files/index.js';
import type { ReadOptions, FileResult, PdfPageItem } from './files/base.js';
import { isPdfFile } from "../../core/tools/mime-types.js";
import { parsePdfToMarkdown, editPdf, PdfOperations, PdfMetadata, parseMarkdownToPdf } from './pdf/index.js';
import { isBinaryFile } from 'isbinaryfile';

export interface FilesystemDependencies {
    configManager: AgentConfigManager;
    capture: Capture;
    fileHandlers: FileHandlerFactory;
}


const FILE_OPERATION_TIMEOUTS = {
    PATH_VALIDATION: 10000,    // 10 seconds
    URL_FETCH: 30000,          // 30 seconds
    FILE_READ: 30000,          // 30 seconds
} as const;







export const READ_OPERATION_TIMEOUT_MS = 3 * 60 * 1000; 

const FILE_SIZE_LIMITS = {
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;



/**
 * Get MIME type information for a file
 * @param filePath Path to the file
 * @returns Object with mimeType and isImage properties
 */
async function getMimeTypeInfo(filePath: string): Promise<{ mimeType: string; isImage: boolean; isPdf: boolean }> {
    const { getMimeType, isImageFile, isPdfFile } = await import('../../core/tools/mime-types.js');
    const mimeType = getMimeType(filePath);
    const isImage = isImageFile(mimeType);
    const isPdf = isPdfFile(mimeType);
    return { mimeType, isImage, isPdf };
}

/**
 * Get file extension for telemetry purposes
 * @param filePath Path to the file
 * @returns Lowercase file extension
 */
function getFileExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
}

/**
 * Get default read length from configuration
 * @returns Default number of lines to read
 */
async function getDefaultReadLength(configManager: AgentConfigManager): Promise<number> {
    const config = await configManager.getConfig();
    return config.fileReadLineLimit ?? AGENT_DEFAULTS.fileReadLineLimit;
}

/**
 * Returns a helpful error message when a file operation fails with a permission
 * or timeout error.
 *
 * Lists all common causes without path-based detection — the AI receiving this
 * error should inspect the path and inform the user which cause is most likely
 * (e.g. cloud storage folder, network drive, system file, locked file, etc.)
 */
function buildPermissionError(filePath: string, errCode: string | undefined): Error {
    const isMac = process.platform === 'darwin';
    const isTimeout = errCode === 'ETIMEDOUT';

    const lines = [
        `Cannot read file — ${isTimeout ? 'operation timed out' : 'permission denied'} (${errCode}).`,
        `Path: ${filePath}`,
        ``,
        `[AI: based on the path above, determine which cause is most likely and explain it to the user.]`,
        ``,
        `Possible causes and fixes:`,
        `  1. File is in cloud storage (Google Drive / iCloud / Dropbox / OneDrive) but not downloaded locally.`,
        `       → Right-click the file and choose "Download Now", "Make Available Offline", or "Keep on This Device".`,
        `  2. Cloud storage app is not running or not signed in.`,
        `       → Open your cloud storage app and make sure it is syncing.`,
        `  3. File is on a network drive or virtual filesystem that is currently unavailable.`,
        `       → Check that the network share or drive is mounted and accessible.`,
        `  4. File has restricted permissions (e.g. system file, locked by another process, or chmod 000).`,
        `       → Check file permissions or close any app that may have the file open.`,
        `  5. The app does not have permission to access this location (macOS Full Disk Access).`,
    ];

    if (isMac) {
        lines.push(`       → Go to System Settings → Privacy & Security → Full Disk Access and enable Claude.`);
        lines.push(`       → To open that pane directly, run in terminal:`);
        lines.push(`           open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`);
        lines.push(`         Then find "Claude" in the list and enable the toggle next to it.`);
    } else {
        lines.push(`       → Check that the app has permission to access this file location.`);
    }

    return new Error(lines.join('\n'));
}


async function getAllowedDirs(configManager: AgentConfigManager): Promise<string[]> {
    let allowedDirectories;
    const config = await configManager.getConfig();
    if (config.allowedDirectories && Array.isArray(config.allowedDirectories)) {
        allowedDirectories = config.allowedDirectories;
    } else {
        
        allowedDirectories = [
            os.homedir()   
        ];
        
        await configManager.setValue('allowedDirectories', allowedDirectories);
    }
    return allowedDirectories;
}


function normalizePath(p: string): string {
    return path.normalize(expandHome(p)).toLowerCase();
}

function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

const realpathCache = new Map<string, string | null>();

async function resolveRealPath(requested: string): Promise<string | null> {
    if (realpathCache.has(requested)) return realpathCache.get(requested) ?? null;
    try {
        const resolved = await fs.realpath(requested, { encoding: 'utf8' });
        realpathCache.set(requested, resolved);
        return resolved;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            realpathCache.set(requested, null);
            return null;
        }
        throw error;
    }
}

async function resolveRealPathOrNull(requested: string): Promise<string | null> {
    try {
        return await resolveRealPath(requested);
    } catch {
        return null;
    }
}

export function invalidateRealpathCache(target?: string): void {
    if (target === undefined) {
        realpathCache.clear();
        return;
    }
    realpathCache.delete(target);
}

/**
 * Recursively validates parent directories until it finds a valid one
 * This function handles the case where we need to create nested directories
 * and we need to check if any of the parent directories exist
 *
 * @param directoryPath The path to validate
 * @returns Promise<boolean> True if a valid parent directory was found
 */
async function validateParentDirectories(directoryPath: string): Promise<boolean> {
    const parentDir = path.dirname(directoryPath);

    
    if (parentDir === directoryPath || parentDir === path.dirname(parentDir)) {
        return false;
    }

    if ((await resolveRealPathOrNull(parentDir)) !== null) return true;
    return validateParentDirectories(parentDir);
}

/**
 * Checks if a path is within any of the allowed directories
 *
 * @param pathToCheck Path to check
 * @returns boolean True if path is allowed
 */
async function isPathAllowed(configManager: AgentConfigManager, pathToCheck: string): Promise<boolean> {
    
    const allowedDirectories = await getAllowedDirs(configManager);
    if (allowedDirectories.includes('/') || allowedDirectories.length === 0) {
        return true;
    }

    let normalizedPathToCheck = normalizePath(pathToCheck);
    if (normalizedPathToCheck.slice(-1) === path.sep) {
        normalizedPathToCheck = normalizedPathToCheck.slice(0, -1);
    }

    const resolvedAllowed = await Promise.all(
        allowedDirectories.map(async (allowedDir) => {
            const resolved = await resolveRealPathOrNull(allowedDir);
            return resolved ?? allowedDir;
        }),
    );

    
    const isAllowed = resolvedAllowed.some(allowedDir => {
        let normalizedAllowedDir = normalizePath(allowedDir);
        if (normalizedAllowedDir.slice(-1) === path.sep) {
            normalizedAllowedDir = normalizedAllowedDir.slice(0, -1);
        }

        
        if (normalizedPathToCheck === normalizedAllowedDir) {
            return true;
        }

        
        
        
        const subdirCheck = normalizedPathToCheck.startsWith(normalizedAllowedDir + path.sep);
        if (subdirCheck) {
            return true;
        }

        
        if (normalizedAllowedDir === 'c:' && process.platform === 'win32') {
            return normalizedPathToCheck.startsWith('c:');
        }

        return false;
    });

    return isAllowed;
}

/**
 * Validates a path to ensure it can be accessed or created.
 * For existing paths, returns the real path (resolving symlinks).
 * For non-existent paths, validates parent directories to ensure they exist.
 *
 * @param requestedPath The path to validate
 * @returns Promise<string> The validated path
 * @throws Error if the path or its parent directories don't exist or if the path is not allowed
 */
export async function validatePath(dependencies: FilesystemDependencies, requestedPath: string): Promise<string> {
    const { configManager, capture } = dependencies;
    const validationOperation = async (): Promise<string> => {
        
        const expandedPath = expandHome(requestedPath);

        
        const absoluteOriginal = path.isAbsolute(expandedPath)
            ? path.resolve(expandedPath)
            : path.resolve(process.cwd(), expandedPath);

        
        
        
        
        
        let resolvedRealPath: string | null = null;
        try {
            resolvedRealPath = await resolveRealPath(absoluteOriginal);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            capture('server_path_realpath_error', {
                error: err.message,
                path: absoluteOriginal
            });
            throw new Error(`Failed to resolve symlink for path: ${absoluteOriginal}. Error: ${err.message}`);
        }

        if (resolvedRealPath === null) {
            
            
            
            
            
            const parentDir = path.dirname(absoluteOriginal);
            const basename = path.basename(absoluteOriginal);
            const resolvedParent = await resolveRealPathOrNull(parentDir);
            if (resolvedParent !== null) {
                resolvedRealPath = path.join(resolvedParent, basename);
            } else {
                let current = absoluteOriginal;
                const remaining: string[] = [];
                while (true) {
                    const parent = path.dirname(current);
                    if (parent === current) break;
                    remaining.unshift(path.basename(current));
                    current = parent;
                    const resolvedAncestor = await resolveRealPathOrNull(current);
                    if (resolvedAncestor !== null) {
                        resolvedRealPath = path.join(resolvedAncestor, ...remaining);
                        break;
                    }
                }
            }
        }

        const pathForNextCheck = resolvedRealPath ?? absoluteOriginal;

        
        if (!(await isPathAllowed(configManager, pathForNextCheck))) {
            capture('server_path_validation_error', {
                error: 'Path not allowed',
                allowedDirsCount: (await getAllowedDirs(configManager)).length
            });

            throw new Error(`Path not allowed: ${requestedPath}. Must be within one of these directories: ${(await getAllowedDirs(configManager)).join(', ')}`);
        }

        
        
        
        

        
        try {
            
            await fs.stat(pathForNextCheck);
            return pathForNextCheck;
        } catch (error) {
            
            if (await validateParentDirectories(pathForNextCheck)) {
                
                
                return pathForNextCheck;
            }
            
            return pathForNextCheck;
        }
    };

    
    const result = await withTimeout(
        validationOperation(),
        FILE_OPERATION_TIMEOUTS.PATH_VALIDATION,
        `Path validation operation`, // Generic name for telemetry
        null
    );

    if (result === null) {
        
        capture('server_path_validation_timeout', {
            timeoutMs: FILE_OPERATION_TIMEOUTS.PATH_VALIDATION
        });

        throw new Error(`Path validation failed for path: ${requestedPath}`);
    }

    return result;
}


export type { FileResult } from './files/base.js';

type PdfPayload = {
    metadata: PdfMetadata;
    pages: PdfPageItem[];
}

type FileResultPayloads = PdfPayload;

/**
 * Read file content from a URL
 * @param url URL to fetch content from
 * @returns File content or file result with metadata
 */
export async function readFileFromUrl(url: string): Promise<FileResult> {
    
    const { isImageFile } = await import('../../core/tools/mime-types.js');

    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FILE_OPERATION_TIMEOUTS.URL_FETCH);

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        
        const contentType = response.headers.get('content-type') || 'text/plain';
        const isImage = isImageFile(contentType);
        const isPdf = isPdfFile(contentType) || url.toLowerCase().endsWith('.pdf');

        
        if (isPdf) {
            
            const pdfResult = await parsePdfToMarkdown(url);

            return {
                content: "",
                mimeType: 'text/plain',
                metadata: {
                    isImage: false,
                    isPdf: true,
                    author: pdfResult.metadata.author,
                    title: pdfResult.metadata.title,
                    totalPages: pdfResult.metadata.totalPages,
                    pages: pdfResult.pages
                }
            };

        } else if (isImage) {
            
            const buffer = await response.arrayBuffer();
            const content = Buffer.from(buffer).toString('base64');

            return { content, mimeType: contentType, metadata: { isImage } };
        } else {
            
            const content = await response.text();

            return { content, mimeType: contentType, metadata: { isImage } };
        }
    } catch (error) {
        
        clearTimeout(timeoutId);

        
        const errorMessage = error instanceof DOMException && error.name === 'AbortError'
            ? `URL fetch timed out after ${FILE_OPERATION_TIMEOUTS.URL_FETCH}ms: ${url}`
            : `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`;

        throw new Error(errorMessage);
    }
}

/**
 * Read file content from the local filesystem
 * @param filePath Path to the file
 * @param options Read options (offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFileFromDisk(
    dependencies: FilesystemDependencies,
    filePath: string,
    options?: ReadOptions
): Promise<FileResult> {
    const { configManager, capture } = dependencies;
    const { offset = 0, sheet, range } = options ?? {};
    let { length } = options ?? {};

    
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path provided');
    }

    
    if (length === undefined) {
        length = await getDefaultReadLength(configManager);
    }

    const validPath = await validatePath(dependencies, filePath);

    
    const fileExtension = getFileExtension(validPath);

    
    try {
        const stats = await fs.stat(validPath);
        if (stats.isDirectory()) {
            const dirListOp = async () => {
                const entries = await listDirectory(dependencies, validPath);
                const listing = entries.join('\n');
                return {
                    content: `This is a directory, not a file. Use the list_directory tool instead of read_file for directories.\n\n${listing}`,
                    mimeType: 'text/plain',
                    metadata: { isImage: false, isDirectory: true }
                } as FileResult;
            };
            const dirResult = await withTimeout(
                dirListOp(),
                FILE_OPERATION_TIMEOUTS.FILE_READ,
                'Directory listing fallback',
                null
            );
            if (dirResult === null) {
                throw new Error(`Directory listing timed out for: ${filePath}`);
            }
            return dirResult;
        }
    } catch (error) {
        
        
        const err = error as NodeJS.ErrnoException;
        if (err.message?.includes('Directory listing') || err.message?.includes('list_directory')) {
            throw error;
        }
        // stat() failed (e.g. ENOENT) — fall through to the read path below
    }

    
    try {
        const stats = await fs.stat(validPath);

        
        capture('server_read_file', {
            fileExtension: fileExtension,
            offset: offset,
            length: length,
            fileSize: stats.size
        });
    } catch (error) {
        console.error('error catch ' + error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_read_file_error', { error: errorMessage, fileExtension: fileExtension });
        // If we can't stat the file, continue anyway and let the read operation handle errors
    }

    
    
    const readOperation = async (signal: AbortSignal) => {
        
        const handler = await dependencies.fileHandlers.getFileHandler(validPath);

        
        const result = await handler.read(validPath, {
            offset,
            length,
            sheet,
            range,
            includeStatusMessage: true,
            signal
        });

        
        
        
        let content: string;
        if (typeof result.content === 'string') {
            content = result.content;
        } else if (result.metadata?.isImage) {
            
            content = result.content.toString('base64');
        } else {
            content = result.content.toString('utf8');
        }

        return {
            content,
            mimeType: result.mimeType,
            metadata: result.metadata
        };
    };

    
    let result;
    try {
        result = await runWithAbortableTimeout(
            (signal) => readOperation(signal),
            READ_OPERATION_TIMEOUT_MS,
            `Read file operation for ${filePath}`
        );
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        
        
        if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ETIMEDOUT') {
            throw buildPermissionError(filePath, err.code);
        }
        throw error;
    }

    if (result == null) {
        
        throw new Error('Failed to read the file');
    }

    return result;
}

/**
 * Read a file from either the local filesystem or a URL
 * @param filePath Path to the file or URL
 * @param options Read options (isUrl, offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFile(
    dependencies: FilesystemDependencies,
    filePath: string,
    options?: ReadOptions
): Promise<FileResult> {
    const { isUrl, offset, length, sheet, range } = options ?? {};
    return isUrl
        ? readFileFromUrl(filePath)
        : readFileFromDisk(dependencies, filePath, { offset, length, sheet, range });
}

/**
 * Read file content without status messages for internal operations
 * This function preserves exact file content including original line endings,
 * which is essential for edit operations that need to maintain file formatting.
 * @param filePath Path to the file
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content without status headers, with preserved line endings
 */
export async function readFileInternal(dependencies: FilesystemDependencies, filePath: string, offset: number = 0, length?: number): Promise<string> {
    const { configManager } = dependencies;
    
    if (length === undefined) {
        length = await getDefaultReadLength(configManager);
    }

    const validPath = await validatePath(dependencies, filePath);

    
    const fileExtension = getFileExtension(validPath);
    const { mimeType, isImage } = await getMimeTypeInfo(validPath);

    if (isImage) {
        throw new Error('Cannot read image files as text for internal operations');
    }

    
    
    

    
    
    
    const content = await runWithAbortableTimeout(
        (signal) => fs.readFile(validPath, { encoding: 'utf8', signal }),
        READ_OPERATION_TIMEOUT_MS,
        `Internal read for ${filePath}`
    );

    
    if (offset === 0 && length >= Number.MAX_SAFE_INTEGER) {
        
        return content;
    }

    
    const lines = TextFileHandler.splitLinesPreservingEndings(content);

    
    const selectedLines = lines.slice(offset, offset + length);

    
    return selectedLines.join('');
}

export async function writeFile(dependencies: FilesystemDependencies, filePath: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
    const { capture } = dependencies;
    const validPath = await validatePath(dependencies, filePath);

    
    const fileExtension = getFileExtension(validPath);

    
    const contentBytes = Buffer.from(content).length;
    const lineCount = TextFileHandler.countLines(content);

    
    capture('server_write_file', {
        fileExtension: fileExtension,
        mode: mode,
        contentBytes: contentBytes,
        lineCount: lineCount
    });

    
    const handler = await dependencies.fileHandlers.getFileHandler(validPath);

    
    await handler.write(validPath, content, mode);
    invalidateRealpathCache();
}

export interface MultiFileResult {
    path: string;
    content?: string;
    mimeType?: string;
    isImage?: boolean;
    error?: string;
    isPdf?: boolean;
    payload?: FileResultPayloads;
}

export async function readMultipleFiles(dependencies: FilesystemDependencies, paths: string[]): Promise<MultiFileResult[]> {
    return Promise.all(
        paths.map(async (filePath: string) => {
            try {
                const validPath = await validatePath(dependencies, filePath);
                const fileResult = await readFile(dependencies, validPath);
                
                let content: string;
                if (typeof fileResult.content === 'string') {
                    content = fileResult.content;
                } else if (fileResult.metadata?.isImage) {
                    content = fileResult.content.toString('base64');
                } else {
                    content = fileResult.content.toString('utf8');
                }

                return {
                    path: filePath,
                    content,
                    mimeType: fileResult.mimeType,
                    isImage: fileResult.metadata?.isImage ?? false,
                    isPdf: fileResult.metadata?.isPdf ?? false,
                    payload: fileResult.metadata?.isPdf ? {
                        metadata: {
                            author: fileResult.metadata.author,
                            title: fileResult.metadata.title,
                            totalPages: fileResult.metadata.totalPages ?? 0
                        },
                        pages: fileResult.metadata.pages ?? []
                    } : undefined
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    path: filePath,
                    error: errorMessage
                };
            }
        }),
    );
}

export async function createDirectory(dependencies: FilesystemDependencies, dirPath: string): Promise<void> {
    const validPath = await validatePath(dependencies, dirPath);
    await fs.mkdir(validPath, { recursive: true });
    invalidateRealpathCache();
}

export async function listDirectory(dependencies: FilesystemDependencies, dirPath: string, depth: number = 2): Promise<string[]> {
    const validPath = await validatePath(dependencies, dirPath);
    const results: string[] = [];

    const MAX_NESTED_ITEMS = 100; 

    async function listRecursive(currentPath: string, currentDepth: number, relativePath: string = '', isTopLevel: boolean = true): Promise<void> {
        if (currentDepth <= 0) return;

        let entries;
        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            const displayPath = relativePath || path.basename(currentPath);
            
            if (err.code === 'ENOENT') {
                results.push(`[NOT_FOUND] ${displayPath} — path does not exist`);
            } else if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ETIMEDOUT') {
                results.push(`[DENIED] ${displayPath} — not accessible (permission denied, cloud-only file, or Full Disk Access not granted)`);
            } else {
                results.push(`[DENIED] ${displayPath}`);
            }
            return;
        }

        
        const totalEntries = entries.length;
        let entriesToShow = entries;
        let filteredCount = 0;

        if (!isTopLevel && totalEntries > MAX_NESTED_ITEMS) {
            entriesToShow = entries.slice(0, MAX_NESTED_ITEMS);
            filteredCount = totalEntries - MAX_NESTED_ITEMS;
        }

        for (const entry of entriesToShow) {
            const fullPath = path.join(currentPath, entry.name);
            const displayPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            
            results.push(`${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${displayPath}`);

            
            if (entry.isDirectory() && currentDepth > 1) {
                try {
                    
                    await validatePath(dependencies, fullPath);
                    await listRecursive(fullPath, currentDepth - 1, displayPath, false);
                } catch (error) {
                    
                    
                    continue;
                }
            }
        }

        
        if (filteredCount > 0) {
            const displayPath = relativePath || path.basename(currentPath);
            results.push(`[WARNING] ${displayPath}: ${filteredCount} items hidden (showing first ${MAX_NESTED_ITEMS} of ${totalEntries} total)`);
        }
    }

    await listRecursive(validPath, depth, '', true);
    return results;
}

export async function moveFile(dependencies: FilesystemDependencies, sourcePath: string, destinationPath: string): Promise<void> {
    const validSourcePath = await validatePath(dependencies, sourcePath);
    const validDestPath = await validatePath(dependencies, destinationPath);
    await fs.rename(validSourcePath, validDestPath);
    invalidateRealpathCache();
}

export async function searchFiles(dependencies: FilesystemDependencies, searchManager: SearchManager, rootPath: string, pattern: string): Promise<string[]> {
    const { capture } = dependencies;
    
    

    try {
        const result = await searchManager.startSearch({
            rootPath,
            pattern,
            searchType: 'files',
            ignoreCase: true,
            maxResults: 5000, // Higher limit for compatibility
            earlyTermination: true, // Use early termination for better performance
        });

        const sessionId = result.sessionId;

        
        let allResults: string[] = [];
        let isComplete = result.isComplete;
        let startTime = Date.now();

        
        for (const searchResult of result.results) {
            if (searchResult.type === 'file') {
                allResults.push(searchResult.file);
            }
        }

        while (!isComplete) {
            await new Promise(resolve => setTimeout(resolve, 100)); 

            const results = searchManager.readSearchResults(sessionId);
            isComplete = results.isComplete;

            
            for (const searchResult of results.results) {
                if (searchResult.file !== '__LAST_READ_MARKER__' && searchResult.type === 'file') {
                    allResults.push(searchResult.file);
                }
            }

            
            if (Date.now() - startTime > 30000) {
                searchManager.terminateSearch(sessionId);
                break;
            }
        }

        
        capture('server_search_files_complete', {
            resultsCount: allResults.length,
            patternLength: pattern.length,
            usedRipgrep: true
        });

        return allResults;
    } catch (error) {
        
        capture('server_search_files_ripgrep_fallback', {
            error: error instanceof Error ? error.message : 'Unknown error'
        });

        return await searchFilesNodeJS(dependencies, rootPath, pattern);
    }
}


async function searchFilesNodeJS(dependencies: FilesystemDependencies, rootPath: string, pattern: string): Promise<string[]> {
    const { capture } = dependencies;
    const results: string[] = [];

    async function search(currentPath: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            return; 
        }

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);

            try {
                await validatePath(dependencies, fullPath);

                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }

                if (entry.isDirectory()) {
                    await search(fullPath);
                }
            } catch (error) {
                continue;
            }
        }
    }

    try {
        
        const validPath = await validatePath(dependencies, rootPath);
        await search(validPath);

        
        capture('server_search_files_complete', {
            resultsCount: results.length,
            patternLength: pattern.length,
            usedRipgrep: false
        });

        return results;
    } catch (error) {
        
        capture('server_search_files_error', {
            errorType: error instanceof Error ? error.name : 'Unknown',
            error: 'Error with root path',
            isRootPathError: true
        });

        
        throw error;
    }
}

export async function getFileInfo(dependencies: FilesystemDependencies, filePath: string): Promise<Record<string, any>> {
    const validPath = await validatePath(dependencies, filePath);

    
    const stats = await fs.stat(validPath);
    const fallbackInfo = {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
        fileType: 'text' as const,
        metadata: undefined as Record<string, any> | undefined,
    };

    
    const handler = await dependencies.fileHandlers.getFileHandler(validPath);

    
    let fileInfo;
    try {
        fileInfo = await handler.getInfo(validPath);
    } catch (error) {
        
        fileInfo = fallbackInfo;
    }

    
    
    const info: Record<string, any> = {
        size: fileInfo.size ?? fallbackInfo.size,
        created: fileInfo.created ?? fallbackInfo.created,
        modified: fileInfo.modified ?? fallbackInfo.modified,
        accessed: fileInfo.accessed ?? fallbackInfo.accessed,
        isDirectory: fileInfo.isDirectory ?? fallbackInfo.isDirectory,
        isFile: fileInfo.isFile ?? fallbackInfo.isFile,
        permissions: fileInfo.permissions ?? fallbackInfo.permissions,
        fileType: fileInfo.fileType ?? fallbackInfo.fileType,
    };

    
    if (fileInfo.metadata) {
        
        if (fileInfo.metadata.lineCount !== undefined) {
            info.lineCount = fileInfo.metadata.lineCount;
            info.lastLine = fileInfo.metadata.lineCount - 1;
            info.appendPosition = fileInfo.metadata.lineCount;
        }

        
        if (fileInfo.metadata.sheets) {
            info.sheets = fileInfo.metadata.sheets;
            info.isExcelFile = true;
        }

        
        if (fileInfo.metadata.isImage) {
            info.isImage = true;
        }

        
        if (fileInfo.metadata.isPdf) {
            info.isPdf = true;
            info.totalPages = fileInfo.metadata.totalPages;
            if (fileInfo.metadata.title) info.title = fileInfo.metadata.title;
            if (fileInfo.metadata.author) info.author = fileInfo.metadata.author;
        }

        
        if (fileInfo.metadata.isBinary) {
            info.isBinary = true;
        }
    }

    return info;
}


/**
 * Write content to a PDF file.
 * Can create a new PDF from Markdown string, or modify an existing PDF using operations.
 * 
 * @param filePath Path to the output PDF file
 * @param content Markdown string (for creation) or array of operations (for modification)
 * @param options Options for PDF generation or modification. For modification, can include `sourcePdf`.
 */
export async function writePdf(
    dependencies: FilesystemDependencies,
    filePath: string,
    content: string | PdfOperations[],
    outputPath?: string,
    options: any = {}
): Promise<void> {
    const { capture } = dependencies;
    const validPath = await validatePath(dependencies, filePath);
    const fileExtension = getFileExtension(validPath);

    if (typeof content === 'string') {
        
        capture('server_write_pdf', {
            fileExtension: fileExtension,
            contentLength: content.length,
            mode: 'create'
        });

        const pdfBuffer = await parseMarkdownToPdf(content, options);
        
        const targetPath = outputPath ? await validatePath(dependencies, outputPath) : validPath;
        await fs.writeFile(targetPath, pdfBuffer);
        invalidateRealpathCache();
    } else if (Array.isArray(content)) {

        
        const targetPath = outputPath ? await validatePath(dependencies, outputPath) : validPath;

        const operations: PdfOperations[] = [];

        
        for (const o of content) {
            if (o.type === 'insert') {
                if (o.sourcePdfPath) {
                    o.sourcePdfPath = await validatePath(dependencies, o.sourcePdfPath);
                }
            }
            operations.push(o);
        }

        capture('server_write_pdf', {
            fileExtension: fileExtension,
            operationCount: operations.length,
            mode: 'modify',
            deleteCount: operations.filter(op => op.type === 'delete').length,
            insertCount: operations.filter(op => op.type === 'insert').length
        });

        
        const modifiedPdfBuffer = await editPdf(validPath, operations);

        
        await fs.writeFile(targetPath, modifiedPdfBuffer);
        invalidateRealpathCache();
    } else {
        throw new Error('Invalid content type for writePdf. Expected string (markdown) or array of operations.');
    }
}

const execFileAsync = promisify(execFile);
type DefaultEditorMetadata = { defaultEditorName?: string; defaultEditorPath?: string };
type DefaultEditorCacheEntry = { metadata: DefaultEditorMetadata; expiresAt?: number };
const DEFAULT_EDITOR_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
const defaultEditorCache = new Map<string, DefaultEditorCacheEntry>();

function escapeAppleScriptString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function getDefaultEditorMetadata(filePath: string): Promise<DefaultEditorMetadata> {
    if (os.platform() !== 'darwin') {
        return {};
    }

    let cacheKey = '';
    try {
        const extension = path.extname(filePath).toLowerCase();
        cacheKey = extension || path.basename(filePath).toLowerCase();
        const cached = defaultEditorCache.get(cacheKey);
        if (cached) {
            if (!cached.expiresAt || cached.expiresAt > Date.now()) {
                return cached.metadata;
            }
            defaultEditorCache.delete(cacheKey);
        }

        const script = `set appAlias to default application of (info for POSIX file "${escapeAppleScriptString(filePath)}")\nreturn (name of (info for appAlias)) & linefeed & POSIX path of appAlias`;
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 12000 });
        const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        const defaultEditorName = lines[lines.length - 2]?.replace(/\.app$/i, '') ?? '';
        const defaultEditorPath = lines[lines.length - 1] ?? '';

        if (defaultEditorName && defaultEditorPath.startsWith('/')) {
            const metadata = { defaultEditorName, defaultEditorPath };
            defaultEditorCache.set(cacheKey, { metadata });
            return metadata;
        }

        defaultEditorCache.set(cacheKey, { metadata: {}, expiresAt: Date.now() + DEFAULT_EDITOR_NEGATIVE_CACHE_MS });
    } catch {
        if (cacheKey) {
            defaultEditorCache.set(cacheKey, { metadata: {}, expiresAt: Date.now() + DEFAULT_EDITOR_NEGATIVE_CACHE_MS });
        }
        // Generic UI fallback is good enough if detection fails.
    }

    return {};
}
