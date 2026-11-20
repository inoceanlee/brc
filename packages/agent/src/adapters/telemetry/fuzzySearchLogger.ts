import fs from 'fs/promises';
import path from 'path';
import { appendRotatingLog } from 'brc-shared';

export interface FuzzySearchLogEntry {
    timestamp: Date;
    searchText: string;
    foundText: string;
    similarity: number;
    executionTime: number;
    exactMatchCount: number;
    expectedReplacements: number;
    fuzzyThreshold: number;
    belowThreshold: boolean;
    diff: string;
    searchLength: number;
    foundLength: number;
    fileExtension: string;
    characterCodes: string;
    uniqueCharacterCount: number;
    diffLength: number;
}

const FUZZY_LOG_HEADERS = [
    'timestamp', 'similarity', 'executionTime', 'exactMatchCount',
    'expectedReplacements', 'fuzzyThreshold', 'belowThreshold',
    'searchLength', 'foundLength', 'fileExtension',
    'uniqueCharacterCount', 'diffLength'
].join('\t');

export class FuzzySearchLogger {
    private logPath: string;
    private initialized = false;

    constructor(logsDirectory: string, private readonly maxBytes: number | (() => Promise<number>)) {
        this.logPath = path.join(logsDirectory, 'fuzzy-search.log');
    }

    private async ensureLogFile(): Promise<void> {
        if (this.initialized) return;

        try {

            const logDir = path.dirname(this.logPath);
            await fs.mkdir(logDir, { recursive: true });


            try {
                await fs.access(this.logPath);
            } catch {

                const headers = FUZZY_LOG_HEADERS;
                await fs.writeFile(this.logPath, headers + '\n');
            }

            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize fuzzy search log file:', error);
            throw error;
        }
    }

    async log(entry: FuzzySearchLogEntry): Promise<void> {
        try {
            const maxBytes = typeof this.maxBytes === 'number' ? this.maxBytes : await this.maxBytes();
            await this.ensureLogFile();


            const logLine = [
                entry.timestamp.toISOString(),
                entry.similarity.toString(),
                entry.executionTime.toString(),
                entry.exactMatchCount.toString(),
                entry.expectedReplacements.toString(),
                entry.fuzzyThreshold.toString(),
                entry.belowThreshold.toString(),
                entry.searchLength.toString(),
                entry.foundLength.toString(),
                entry.fileExtension,
                entry.uniqueCharacterCount.toString(),
                entry.diffLength.toString()
            ].join('\t');

            await appendRotatingLog(this.logPath, logLine + '\n', maxBytes);
        } catch (error) {
            console.error('Failed to write to fuzzy search log:', error);
        }
    }

    async getLogPath(): Promise<string> {
        await this.ensureLogFile();
        return this.logPath;
    }

    async getRecentLogs(count: number = 10): Promise<string[]> {
        try {
            await this.ensureLogFile();
            const content = await fs.readFile(this.logPath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim() && line !== FUZZY_LOG_HEADERS);
            const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
            return limit === 0 ? [] : lines.slice(-limit);
        } catch (error) {
            console.error('Failed to read fuzzy search logs:', error);
            return [];
        }
    }

    async clearLog(): Promise<void> {
        try {

            const headers = FUZZY_LOG_HEADERS;

            await fs.rm(`${this.logPath}.1`, { force: true });
            await fs.writeFile(this.logPath, headers + '\n');
            process.stderr.write('Agent fuzzy-search diagnostics cleared.\n');
        } catch (error) {
            console.error('Failed to clear fuzzy search log:', error);
        }
    }
}

