/**
 * Text file handler
 * Handles reading, writing, and editing text files
 *
 * Binary detection is handled at the factory level (factory.ts) using isBinaryFile.
 * This handler only receives files that have been confirmed as text.
 *
 * TECHNICAL DEBT:
 * This handler is missing editRange() - text search/replace logic currently lives in
 * src/tools/edit.ts (performSearchReplace function) instead of here.
 *
 * For architectural consistency with ExcelFileHandler.editRange(), the fuzzy
 * search/replace logic should be moved here. See comment in src/tools/edit.ts.
 */

import fs from "fs/promises";
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';
import { AGENT_DEFAULTS } from '../../../core/config.js';
import { TextReader } from './text-reader.js';

// TODO: Centralize these constants with filesystem.ts to avoid silent drift
// These duplicate concepts from filesystem.ts and should be moved to a shared
// constants module (e.g., src/utils/files/constants.ts) during reorganization
const FILE_SIZE_LIMITS = {
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;


/**
 * Text file handler implementation
 * Binary detection is done at the factory level - this handler assumes file is text
 */
export class TextFileHandler implements FileHandler {
    private readonly reader = new TextReader(TextFileHandler.countLines, this.generateEnhancedStatusMessage);

    canHandle(_path: string): boolean {
        // Text handler accepts all files that pass the factory's binary check
        // The factory routes binary files to BinaryFileHandler before reaching here
        return true;
    }


    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        const offset = options?.offset ?? 0;
        const length = options?.length ?? AGENT_DEFAULTS.fileReadLineLimit;
        const includeStatusMessage = options?.includeStatusMessage ?? true;

        // Binary detection is done at factory level - just read as text
        return this.reader.readFileWithSmartPositioning(filePath, offset, length, 'text/plain', includeStatusMessage, options?.signal);
    }

    async write(path: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        if (mode === 'append') {
            await fs.appendFile(path, content);
        } else {
            await fs.writeFile(path, content);
        }
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        const info: FileInfo = {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'text',
            metadata: {}
        };

        // For text files that aren't too large, count lines
        if (stats.isFile() && stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
            try {
                const encoding = await this.reader.detectTextEncoding(path);
                let content = await fs.readFile(path, encoding);
                if (encoding === 'utf16le' && content.charCodeAt(0) === 0xfeff) {
                    content = content.slice(1);
                }
                const lineCount = TextFileHandler.countLines(content);
                info.metadata!.lineCount = lineCount;
            } catch (error) {
                // If reading fails, skip line count
            }
        }

        return info;
    }

    // ========================================================================
    // Private Helper Methods (extracted from filesystem.ts)
    // ========================================================================

    /**
     * Count lines in text content
     * Made static and public for use by other modules (e.g., writeFile telemetry in filesystem.ts)
     */
    static countLines(content: string): number {
        if (content === '') return 0;
        // A file with N lines has N-1 newline characters.
        // If the file ends with a trailing newline, don't count the empty string after it.
        const lines = content.split('\n');
        if (lines[lines.length - 1] === '') {
            return lines.length - 1;
        }
        return lines.length;
    }


    /**
     * Generate enhanced status message
     */
    private generateEnhancedStatusMessage(
        readLines: number,
        offset: number,
        totalLines?: number,
        isNegativeOffset: boolean = false
    ): string {
        if (isNegativeOffset) {
            if (totalLines !== undefined) {
                return `[Reading last ${readLines} lines (total: ${totalLines} lines)]`;
            } else {
                return `[Reading last ${readLines} lines]`;
            }
        } else {
            if (totalLines !== undefined) {
                const endLine = offset + readLines;
                const remainingLines = Math.max(0, totalLines - endLine);

                if (offset === 0) {
                    return `[Reading ${readLines} lines from start (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset} (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                }
            } else {
                if (offset === 0) {
                    return `[Reading ${readLines} lines from start]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset}]`;
                }
            }
        }
    }

    /**
     * Split text into lines while preserving line endings
     * Made static and public for use by other modules (e.g., readFileInternal in filesystem.ts)
     */
    static splitLinesPreservingEndings(content: string): string[] {
        if (!content) return [''];

        const lines: string[] = [];
        let currentLine = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            currentLine += char;

            if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
            } else if (char === '\r') {
                if (i + 1 < content.length && content[i + 1] === '\n') {
                    currentLine += content[i + 1];
                    i++;
                }
                lines.push(currentLine);
                currentLine = '';
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

}
