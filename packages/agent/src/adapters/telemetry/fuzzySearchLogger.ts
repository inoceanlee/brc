import fs from 'fs/promises';
import path from 'path';
import { resolveAgentHome } from '../../core/config.js';
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
    'timestamp',
    'searchText',
    'foundText',
    'similarity',
    'executionTime',
    'exactMatchCount',
    'expectedReplacements',
    'fuzzyThreshold',
    'belowThreshold',
    'diff',
    'searchLength',
    'foundLength',
    'fileExtension',
    'characterCodes',
    'uniqueCharacterCount',
    'diffLength'
].join('\t');

class FuzzySearchLogger {
    private logPath: string;
    private initialized = false;

    constructor() {
        // Create log file in a dedicated directory
        const logDir = path.join(resolveAgentHome(process.env), 'logs');
        this.logPath = path.join(logDir, 'fuzzy-search.log');
    }

    private async ensureLogFile(): Promise<void> {
        if (this.initialized) return;
        
        try {
            // Create log directory if it doesn't exist
            const logDir = path.dirname(this.logPath);
            await fs.mkdir(logDir, { recursive: true });
            
            // Check if log file exists, create with headers if not
            try {
                await fs.access(this.logPath);
            } catch {
                // File doesn't exist, create with headers
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
            await this.ensureLogFile();
            
            // Convert entry to tab-separated string
            const logLine = [
                entry.timestamp.toISOString(),
                entry.searchText.replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
                entry.foundText.replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
                entry.similarity.toString(),
                entry.executionTime.toString(),
                entry.exactMatchCount.toString(),
                entry.expectedReplacements.toString(),
                entry.fuzzyThreshold.toString(),
                entry.belowThreshold.toString(),
                entry.diff.replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
                entry.searchLength.toString(),
                entry.foundLength.toString(),
                entry.fileExtension,
                entry.characterCodes,
                entry.uniqueCharacterCount.toString(),
                entry.diffLength.toString()
            ].join('\t');
            
            await appendRotatingLog(this.logPath, logLine + '\n');
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
            // Recreate with just headers
            const headers = FUZZY_LOG_HEADERS;
            
            await fs.rm(`${this.logPath}.1`, { force: true });
            await fs.writeFile(this.logPath, headers + '\n');
            console.log('Fuzzy search log cleared');
        } catch (error) {
            console.error('Failed to clear fuzzy search log:', error);
        }
    }
}

// Singleton instance
export const fuzzySearchLogger = new FuzzySearchLogger();
