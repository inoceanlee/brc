import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { FileResult } from './base.js';

const FILE_SIZE_LIMITS = {
    LARGE_FILE_THRESHOLD: 10 * 1024 * 1024,  // 10MB
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

const READ_PERFORMANCE_THRESHOLDS = {
    SMALL_READ_THRESHOLD: 100,    // For very small reads
    DEEP_OFFSET_THRESHOLD: 1000,  // For byte estimation
    SAMPLE_SIZE: 10000,           // Sample size for estimation
    CHUNK_SIZE: 8192,             // 8KB chunks for reverse reading
} as const;

export class TextReader {
    constructor(
        private readonly countLines: (content: string) => number,
        private readonly generateEnhancedStatusMessage: (readLines: number, offset: number, totalLines?: number, isNegativeOffset?: boolean) => string
    ) {}

    async detectTextEncoding(filePath: string): Promise<'utf8' | 'utf16le'> {
        const fd = await fs.open(filePath, 'r');
        try {
            const bom = Buffer.alloc(2);
            const { bytesRead } = await fd.read(bom, 0, bom.length, 0);
            if (bytesRead === 2 && bom[0] === 0xff && bom[1] === 0xfe) {
                return 'utf16le';
            }
            return 'utf8';
        } finally {
            await fd.close();
        }
    }

    /**
     * Get file line count (for files under size limit)
     */
    async getFileLineCount(
        filePath: string,
        signal?: AbortSignal,
        encoding: 'utf8' | 'utf16le' = 'utf8'
    ): Promise<number | undefined> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
                let content = await fs.readFile(filePath, { encoding, signal });
                if (encoding === 'utf16le' && content.charCodeAt(0) === 0xfeff) {
                    content = content.slice(1);
                }
                return this.countLines(content);
            }
        } catch (error) {
            // If we can't read the file, return undefined
        }
        return undefined;
    }

    /**
     * Read file with smart positioning for optimal performance
     */
    async readFileWithSmartPositioning(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;
        const encoding = await this.detectTextEncoding(filePath);
        const totalLines = await this.getFileLineCount(filePath, signal, encoding);

        // UTF-16LE needs character-aware streaming. Skip the two-byte BOM and keep
        // the same line pagination/status semantics as ordinary text reads.
        if (encoding === 'utf16le') {
            if (offset < 0) {
                return await this.readFromEndWithReadline(
                    filePath, Math.abs(offset), mimeType, includeStatusMessage,
                    totalLines, signal, 'utf16le', 2
                );
            }
            return await this.readFromStartWithReadline(
                filePath, offset, length, mimeType, includeStatusMessage,
                totalLines, signal, 'utf16le', 2
            );
        }

        // For negative offsets (tail behavior), use reverse reading
        if (offset < 0) {
            const requestedLines = Math.abs(offset);

            if (fileSize > FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD &&
                requestedLines <= READ_PERFORMANCE_THRESHOLDS.SMALL_READ_THRESHOLD) {
                return await this.readLastNLinesReverse(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            } else {
                return await this.readFromEndWithReadline(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            }
        }
        // For positive offsets
        else {
            if (fileSize < FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD || offset === 0) {
                return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
            } else {
                if (offset > READ_PERFORMANCE_THRESHOLDS.DEEP_OFFSET_THRESHOLD) {
                    return await this.readFromEstimatedPosition(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
                } else {
                    return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines, signal);
                }
            }
        }
    }

    /**
     * Read last N lines efficiently by reading file backwards
     */
    private async readLastNLinesReverse(
        filePath: string,
        n: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const fileSize = stats.size;

            let position = fileSize;
            const chunks: Buffer[] = [];
            let newlineCount = 0;
            let requiredNewlines = n;

            while (position > 0 && newlineCount < requiredNewlines) {
                if (signal?.aborted) {
                    const err = new Error('Read aborted') as NodeJS.ErrnoException;
                    err.code = 'ABORT_ERR';
                    throw err;
                }
                const readSize = Math.min(READ_PERFORMANCE_THRESHOLDS.CHUNK_SIZE, position);
                position -= readSize;

                const buffer = Buffer.alloc(readSize);
                await fd.read(buffer, 0, readSize, position);
                if (chunks.length === 0 && buffer[readSize - 1] === 0x0a) {
                    requiredNewlines++;
                }

                chunks.push(buffer);
                for (const byte of buffer) {
                    if (byte === 0x0a) newlineCount++;
                }
            }

            const lines = Buffer.concat(chunks.reverse()).toString('utf8').split('\n');
            if (lines[lines.length - 1] === '') lines.pop();
            if (position > 0) lines.shift();
            const result = lines.slice(-n).map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, -n, fileTotalLines, true)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }

    /**
     * Read from end using readline with circular buffer
     */
    private async readFromEndWithReadline(
        filePath: string,
        requestedLines: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal,
        encoding?: BufferEncoding,
        start?: number
    ): Promise<FileResult> {
        const rl = createInterface({
            input: createReadStream(filePath, { signal, encoding, start }),
            crlfDelay: Infinity
        });

        const buffer: string[] = new Array(requestedLines);
        let bufferIndex = 0;
        let totalLines = 0;

        for await (const line of rl) {
            buffer[bufferIndex] = line;
            bufferIndex = (bufferIndex + 1) % requestedLines;
            totalLines++;
        }

        rl.close();

        let result: string[];
        if (totalLines >= requestedLines) {
            result = [
                ...buffer.slice(bufferIndex),
                ...buffer.slice(0, bufferIndex)
            ].filter(line => line !== undefined);
        } else {
            result = buffer.slice(0, totalLines);
        }

        const content = includeStatusMessage
            ? `${this.generateEnhancedStatusMessage(result.length, -requestedLines, fileTotalLines, true)}\n\n${result.join('\n')}`
            : result.join('\n');

        return { content, mimeType, metadata: {} };
    }

    /**
     * Read from start/middle using readline
     */
    private async readFromStartWithReadline(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal,
        encoding?: BufferEncoding,
        start?: number
    ): Promise<FileResult> {
        const rl = createInterface({
            input: createReadStream(filePath, { signal, encoding, start }),
            crlfDelay: Infinity
        });

        const result: string[] = [];
        let lineNumber = 0;

        for await (const line of rl) {
            if (lineNumber >= offset && result.length < length) {
                result.push(line);
            }
            if (result.length >= length) break;
            lineNumber++;
        }

        rl.close();

        if (includeStatusMessage) {
            const statusMessage = this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false);
            const content = `${statusMessage}\n\n${result.join('\n')}`;
            return { content, mimeType, metadata: {} };
        } else {
            const content = result.join('\n');
            return { content, mimeType, metadata: {} };
        }
    }

    /**
     * Read from estimated byte position for very large files
     */
    private async readFromEstimatedPosition(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        // First, do a quick scan to estimate lines per byte
        const rl = createInterface({
            input: createReadStream(filePath, { signal }),
            crlfDelay: Infinity
        });

        let sampleLines = 0;
        let bytesRead = 0;

        for await (const line of rl) {
            bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
            sampleLines++;
            if (bytesRead >= READ_PERFORMANCE_THRESHOLDS.SAMPLE_SIZE) break;
        }

        rl.close();

        if (sampleLines === 0) {
            return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, fileTotalLines, signal);
        }

        // Estimate position
        const avgLineLength = bytesRead / sampleLines;
        const estimatedBytePosition = Math.floor(offset * avgLineLength);

        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const startPosition = Math.min(estimatedBytePosition, stats.size);

            const stream = createReadStream(filePath, { start: startPosition, signal });
            const rl2 = createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            const result: string[] = [];
            let firstLineSkipped = false;

            for await (const line of rl2) {
                if (!firstLineSkipped && startPosition > 0) {
                    firstLineSkipped = true;
                    continue;
                }

                if (result.length < length) {
                    result.push(line);
                } else {
                    break;
                }
            }

            rl2.close();

            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }
}
