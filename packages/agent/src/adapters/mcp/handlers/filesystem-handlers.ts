import {
    readFile,
    readMultipleFiles,
    writeFile,
    createDirectory,
    listDirectory,
    moveFile,
    getFileInfo,
    writePdf,
    getDefaultEditorMetadata,
    type FileResult,
    type MultiFileResult,
    type FilesystemDependencies
} from '../../filesystem/filesystem.js';
import type { ReadOptions } from '../../filesystem/files/base.js';

import { ServerResult } from '../../../core/types.js';
import { withTimeout } from '../../system/timeout.js';
import { createErrorResponse } from '../error-handlers.js';
import { AGENT_DEFAULTS } from '../../../core/config.js';

import {
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    WritePdfArgsSchema
} from '../schemas.js';
import path from 'path';
import os from 'os';
import { resolvePreviewFileType } from '../../../core/ui/file-preview/shared/preview-file-types.js';

/**
 * Expand home directory (~) in a file path
 */
function expandHome(filePath: string): string {
    if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith(`~${path.sep}`)) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

/**
 * Resolve a file path to an absolute path for use in structured content.
 * This ensures "Open in folder" always has a valid absolute path.
 */
export function resolveAbsolutePath(filePath: string): string {
    const expanded = expandHome(filePath);
    return path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(process.cwd(), expanded);
}

/**
 * Helper function to check if path contains an error
 */
function isErrorPath(filePath: string): boolean {
    return filePath.startsWith('__ERROR__:');
}

/**
 * Extract error message from error path
 */
function getErrorFromPath(path: string): string {
    return path.substring('__ERROR__:'.length).trim();
}

/**
 * Handle read_file command
 */
export async function handleReadFile(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    const { configManager } = dependencies;





    const HANDLER_TIMEOUT = 3.5 * 60 * 1000; 

    if (args === null || args === undefined) {
        return createErrorResponse('No arguments provided for read_file command', dependencies.capture);
    }
    const readFileOperation = async () => {
        const parsed = ReadFileArgsSchema.parse(args);


        const config = await configManager.getConfig();
        if (!config) {
            return createErrorResponse('Configuration not available', dependencies.capture);
        }

        const defaultLimit = config.fileReadLineLimit ?? AGENT_DEFAULTS.fileReadLineLimit;


        let sheetParam: string | number | undefined = parsed.sheet;
        if (parsed.sheet !== undefined && /^\d+$/.test(parsed.sheet)) {
            sheetParam = parseInt(parsed.sheet, 10);
        }

        const options: ReadOptions = {
            isUrl: parsed.isUrl,
            offset: parsed.offset ?? 0,
            length: parsed.length ?? defaultLimit,
            sheet: sheetParam,
            range: parsed.range
        };


        const resolvedFilePath = parsed.isUrl
            ? parsed.path
            : resolveAbsolutePath(parsed.path);

        const fileResult = await readFile(dependencies, parsed.path, options);


        if (fileResult.metadata?.isPdf) {
            const meta = fileResult.metadata;
            const author = meta?.author ? `, Author: ${meta?.author}` : "";
            const title = meta?.title ? `, Title: ${meta?.title}` : "";

            const pdfContent = fileResult.metadata?.pages?.flatMap((p: any) => [
                ...(p.images?.map((image: any) => ({
                    type: "image",
                    data: image.data,
                    mimeType: image.mimeType
                })) ?? []),
                {
                    type: "text",
                    text: `<!-- Page: ${p.pageNumber} -->\n${p.text}`,
                },
            ]) ?? [];

            return {
                content: [
                    {
                        type: "text",
                        text: `PDF file: ${parsed.path}${author}${title} (${meta?.totalPages} pages) \n`
                    },
                    ...pdfContent
                ],
                ...(parsed.origin === 'ui' ? {
                    structuredContent: {
                        fileName: path.basename(resolvedFilePath),
                        filePath: resolvedFilePath,
                        fileType: 'unsupported' as const,
                        ...await getDefaultEditorMetadata(resolvedFilePath),
                    },
                } : {}),
            };
        }


        if (fileResult.metadata?.isImage) {



            const imageData = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('base64');
            const imageSummary = `Image file: ${parsed.path} (${fileResult.mimeType})\n`;
            const imageStructuredContent = {
                fileName: path.basename(resolvedFilePath),
                filePath: resolvedFilePath,
                fileType: 'image' as const,
                ...await getDefaultEditorMetadata(resolvedFilePath),
                mimeType: fileResult.mimeType,
            };






            if (parsed.origin === 'ui') {
                return {
                    content: [{ type: "text", text: imageData }],
                    structuredContent: imageStructuredContent,
                };
            }



            return {
                content: [
                    {
                        type: "text",
                        text: imageSummary
                    },
                    {
                        type: "image",
                        data: imageData,
                        mimeType: fileResult.mimeType
                    }
                ],
            };
        } else {



            let textContent = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('utf8');
            const fileType = fileResult.metadata?.isDirectory ? 'directory' as const : resolvePreviewFileType(resolvedFilePath);



            if (parsed.origin === 'ui' && fileType === 'directory') {
                textContent = textContent.replace(/^This is a directory, not a file\.[^\n]*\n+/, '');
            }
            return {
                content: [{ type: "text", text: textContent }],
                ...(parsed.origin === 'ui' ? {
                    structuredContent: {
                        fileName: path.basename(resolvedFilePath),
                        filePath: resolvedFilePath,
                        fileType,
                        ...await getDefaultEditorMetadata(resolvedFilePath),
                    },
                } : {}),
            };
        }
    };


    const result = await withTimeout(
        readFileOperation(),
        HANDLER_TIMEOUT,
        'Read file handler operation',
        null
    );
    if (result == null) {

        throw new Error('Failed to read the file');
    }
    return result;
}

/**
 * Handle read_multiple_files command
 */
export async function handleReadMultipleFiles(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    const parsed = ReadMultipleFilesArgsSchema.parse(args);
    const fileResults = await readMultipleFiles(dependencies, parsed.paths);


    const textSummary = fileResults.map(result => {
        if (result.error) {
            return `${result.path}: Error - ${result.error}`;
        } else if (result.isPdf) {
            return `${result.path}: PDF file with ${result.payload?.pages?.length} pages`;
        } else if (result.mimeType) {
            return `${result.path}: ${result.mimeType} ${result.isImage ? '(image)' : '(text)'}`;
        } else {
            return `${result.path}: Unknown type`;
        }
    }).join("\n");


    const contentItems: Array<{ type: string, text?: string, data?: string, mimeType?: string }> = [];


    contentItems.push({ type: "text", text: textSummary });


    for (const result of fileResults) {
        if (!result.error && result.content !== undefined) {
            if (result.isPdf) {
                result.payload?.pages.forEach((page, i) => {
                    page.images.forEach((image, i) => {
                        contentItems.push({
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType
                        });
                    });
                    contentItems.push({
                        type: "text",
                        text: page.text,
                    });
                });
            } else if (result.isImage && result.mimeType) {

                contentItems.push({
                    type: "image",
                    data: result.content,
                    mimeType: result.mimeType
                });
            } else {

                contentItems.push({
                    type: "text",
                    text: `\n--- ${result.path} contents: ---\n${result.content}`
                });
            }
        }
    }

    return { content: contentItems };
}

/**
 * Handle write_file command
 */
export async function handleWriteFile(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    const { configManager } = dependencies;
    try {
        const modeProvided = !!(args && typeof args === 'object' && 'mode' in args);
        const parsed = WriteFileArgsSchema.parse(args);






        if (!modeProvided) {
            let existing: Record<string, any> | null = null;
            try {
                existing = await getFileInfo(dependencies, parsed.path);
            } catch {


            }
            if (existing?.isFile && existing.size > 0) {
                return createErrorResponse(
                    `Write rejected to prevent accidental data loss: ${parsed.path} already exists ` +
                    `with content (${existing.size} bytes), and no 'mode' was specified — the default ` +
                    `mode 'rewrite' would REPLACE the entire file. Retry with an explicit mode: ` +
                    `'append' to add your content to the end of the existing file, or 'rewrite' ` +
                    `to replace all existing content.`, dependencies.capture
                );
            }
        }


        const config = await configManager.getConfig();
        const MAX_LINES = config.fileWriteLineLimit ?? AGENT_DEFAULTS.fileWriteLineLimit;


        const lines = parsed.content.split('\n');
        const lineCount = lines.length;
        let errorMessage = "";
        if (lineCount > MAX_LINES) {
            errorMessage = `✅ File written successfully! (${lineCount} lines)
            
💡 Performance tip: For optimal speed, consider chunking files into ≤30 line pieces in future operations.`;
        }


        await writeFile(dependencies, parsed.path, parsed.content, parsed.mode);


        const modeMessage = parsed.mode === 'append' ? 'appended to' : 'wrote to';



        return {
            content: [{
                type: "text",
                text: `Successfully ${modeMessage} ${parsed.path} (${lineCount} lines) ${errorMessage}`
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}

/**
 * Handle create_directory command
 */
export async function handleCreateDirectory(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    try {
        const parsed = CreateDirectoryArgsSchema.parse(args);
        await createDirectory(dependencies, parsed.path);
        return {
            content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}

/**
 * Handle list_directory command
 */
export async function handleListDirectory(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    try {
        const startTime = Date.now();
        const parsed = ListDirectoryArgsSchema.parse(args);
        const entries = await listDirectory(dependencies, parsed.path, parsed.depth);
        const duration = Date.now() - startTime;

        const resultText = entries.join('\n');
        const resolvedPath = resolveAbsolutePath(parsed.path);

        return {
            content: [{ type: "text", text: resultText }],
            ...(parsed.origin === 'ui' ? {
                structuredContent: {
                    fileName: path.basename(resolvedPath),
                    filePath: resolvedPath,
                    fileType: 'directory' as const,
                },
            } : {}),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}

/**
 * Handle move_file command
 */
export async function handleMoveFile(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    try {
        const parsed = MoveFileArgsSchema.parse(args);
        await moveFile(dependencies, parsed.source, parsed.destination);
        return {
            content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}

/**
 * Format a value for display, handling objects and arrays
 */
function formatValue(value: unknown, indent: string = ''): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';

        const items = value.map((item, i) => {
            if (typeof item === 'object' && item !== null) {
                const props = Object.entries(item)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `${indent}  [${i}] { ${props} }`;
            }
            return `${indent}  [${i}] ${item}`;
        });
        return `\n${items.join('\n')}`;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Handle get_file_info command
 */
export async function handleGetFileInfo(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    try {
        const parsed = GetFileInfoArgsSchema.parse(args);
        const info = await getFileInfo(dependencies, parsed.path);


        const formattedText = Object.entries(info)
            .map(([key, value]) => `${key}: ${formatValue(value)}`)
            .join('\n');

        return {
            content: [{
                type: "text",
                text: formattedText
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}



/**
 * Handle write_pdf command
 */
export async function handleWritePdf(args: unknown, dependencies: FilesystemDependencies): Promise<ServerResult> {
    try {
        const parsed = WritePdfArgsSchema.parse(args);
        await writePdf(dependencies, parsed.path, parsed.content, parsed.outputPath, parsed.options);
        const targetPath = parsed.outputPath || parsed.path;
        return {
            content: [{ type: "text", text: `Successfully wrote PDF to ${targetPath}${parsed.outputPath ? `\nOriginal file: ${parsed.path}` : ''}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }
}
