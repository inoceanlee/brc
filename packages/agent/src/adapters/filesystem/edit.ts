/**
 * Text file editing via search/replace with fuzzy matching support.
 *
 * TECHNICAL DEBT / ARCHITECTURAL NOTE:
 * This file contains text editing logic that should ideally live in TextFileHandler.editRange()
 * to be consistent with how Excel editing works (ExcelFileHandler.editRange()).
 *
 * Current inconsistency:
 * - Excel: edit_block → ExcelFileHandler.editRange() ✓ uses file handler
 * - Text:  edit_block → performSearchReplace() here → bypasses TextFileHandler
 *
 * Future refactor should:
 * Move performSearchReplace() + fuzzy logic into TextFileHandler.editRange()
 * Make this file a thin dispatch layer that routes to appropriate FileHandler
 * Unify the editRange() signature to handle both text search/replace and structured edits
 */

import { getDefaultEditorMetadata, readFile, writeFile, readFileInternal, validatePath, type FilesystemDependencies } from './filesystem.js';
import fs from 'fs/promises';
import { ServerResult } from '../../core/types.js';
import { runFuzzySearchInWorker, getSimilarityRatio } from './fuzzy-search.js';
import { createErrorResponse } from '../mcp/error-handlers.js';
import { EditBlockArgsSchema } from "../../core/tools/schemas.js";
import path from 'path';
import { detectLineEnding, normalizeLineEndings } from './line-endings.js';
import { AGENT_DEFAULTS } from '../../core/config.js';
import type { FuzzySearchLogger, FuzzySearchLogEntry } from '../telemetry/fuzzySearchLogger.js';
import { resolvePreviewFileType } from '../../core/ui/file-preview/shared/preview-file-types.js';
import { resolveAbsolutePath } from '../mcp/handlers/filesystem-handlers.js';
import type { FileHandler } from './files/base.js';

export interface EditDependencies extends FilesystemDependencies {
    fuzzySearchLogger: FuzzySearchLogger;
}

interface SearchReplace {
    search: string;
    replace: string;
}

interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
    similarity: number;
}

/**
 * Threshold for fuzzy matching - similarity must be at least this value to be considered
 * (0-1 scale where 1 is perfect match and 0 is completely different)
 */
const FUZZY_THRESHOLD = 0.7;

/**
 * Extract character code data from diff
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns Character code statistics
 */
function getCharacterCodeData(expected: string, actual: string): {
    report: string;
    uniqueCount: number;
    diffLength: number;
} {
    
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    
    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);
    
    
    const characterCodes = new Map<number, number>();
    const fullDiff = expectedDiff + actualDiff;
    
    for (let i = 0; i < fullDiff.length; i++) {
        const charCode = fullDiff.charCodeAt(i);
        characterCodes.set(charCode, (characterCodes.get(charCode) || 0) + 1);
    }
    
    
    const charCodeReport: string[] = [];
    characterCodes.forEach((count, code) => {
        
        const char = String.fromCharCode(code);
        
        const charDisplay = code < 32 || code > 126 ? `\\x${code.toString(16).padStart(2, '0')}` : char;
        charCodeReport.push(`${code}:${count}[${charDisplay}]`);
    });
    
    
    charCodeReport.sort((a, b) => {
        const codeA = parseInt(a.split(':')[0]);
        const codeB = parseInt(b.split(':')[0]);
        return codeA - codeB;
    });
    
    return {
        report: charCodeReport.join(','),
        uniqueCount: characterCodes.size,
        diffLength: fullDiff.length
    };
}

export async function performSearchReplace(dependencies: EditDependencies, filePath: string, block: SearchReplace, expectedReplacements: number = 1, origin?: 'ui' | 'llm'): Promise<ServerResult> {
    const { configManager, fuzzySearchLogger, capture } = dependencies;
    
    const fileExtension = path.extname(filePath).toLowerCase();
    
    
    capture('server_edit_block', {
        fileExtension: fileExtension,
        oldStringLength: block.search.length,
        oldStringLines: block.search.split('\n').length,
        newStringLength: block.replace.length,
        newStringLines: block.replace.split('\n').length,
        expectedReplacements: expectedReplacements
    });
    
    if (block.search === "") {
    
        
        capture('server_edit_block_empty_search', {fileExtension: fileExtension, expectedReplacements});
        return {
            content: [{ 
                type: "text", 
                text: "Empty search strings are not allowed. Please provide a non-empty string to search for."
            }],
        };
    }
    

    
    const validPath = await validatePath(dependencies, filePath);
    const content = await readFileInternal(dependencies, validPath, 0, Number.MAX_SAFE_INTEGER);
    
    
    if (typeof content !== 'string') {
        capture('server_edit_block_content_not_string', {fileExtension: fileExtension, expectedReplacements});
        throw new Error('Wrong content for file ' + filePath);
    }
    
    
    const config = await configManager.getConfig();
    const MAX_LINES = config.fileWriteLineLimit ?? AGENT_DEFAULTS.fileWriteLineLimit;
    
    
    const fileLineEnding = detectLineEnding(content);
    
    
    const normalizedSearch = normalizeLineEndings(block.search, fileLineEnding);
    
    
    let tempContent = content;
    let count = 0;
    let pos = tempContent.indexOf(normalizedSearch);
    
    while (pos !== -1) {
        count++;
        pos = tempContent.indexOf(normalizedSearch, pos + 1);
    }
    
    
    if (count > 0 && count === expectedReplacements) {
        
        let newContent = content;
        
        
        if (expectedReplacements === 1) {
            const searchIndex = newContent.indexOf(normalizedSearch);
            newContent = 
                newContent.substring(0, searchIndex) + 
                normalizeLineEndings(block.replace, fileLineEnding) + 
                newContent.substring(searchIndex + normalizedSearch.length);
        } else {
            
            newContent = newContent.split(normalizedSearch).join(normalizeLineEndings(block.replace, fileLineEnding));
        }
        
        
        const searchLines = block.search.split('\n').length;
        const replaceLines = block.replace.split('\n').length;
        const maxLines = Math.max(searchLines, replaceLines);
        let warningMessage = "";
        
        if (maxLines > MAX_LINES) {
            const problemText = searchLines > replaceLines ? 'search text' : 'replacement text';
            warningMessage = `\n\nWARNING: The ${problemText} has ${maxLines} lines (maximum: ${MAX_LINES}).
            
RECOMMENDATION: For large search/replace operations, consider breaking them into smaller chunks with fewer lines.`;
        }
        
        await writeFile(dependencies, filePath, newContent);
        capture('server_edit_block_exact_success', {fileExtension: fileExtension, expectedReplacements, hasWarning: warningMessage !== ""});
        const resolvedEditPath = resolveAbsolutePath(filePath);

        
        const newLines = newContent.split('\n');
        const totalLines = newLines.length;
        const changePos = content.indexOf(normalizedSearch);
        const changeStartLine = changePos >= 0 ? newContent.substring(0, changePos).split('\n').length - 1 : 0;
        const changeLineCount = block.replace.split('\n').length;
        const contextLines = 10;
        const previewStart = Math.max(0, changeStartLine - contextLines);
        const previewEnd = Math.min(totalLines, changeStartLine + changeLineCount + contextLines);
        const previewContent = newLines.slice(previewStart, previewEnd).join('\n');
        const previewLineCount = previewEnd - previewStart;
        const remaining = totalLines - previewEnd;
        const statusLine = `[Reading ${previewLineCount} lines from ${previewStart === 0 ? 'start' : `line ${previewStart}`} (total: ${totalLines} lines, ${remaining} remaining)]\n\n`;

        return {
            content: [{
                type: "text",
                text: `${statusLine}${previewContent}`
            }],
            
            
            
            
            ...(origin === 'ui' ? {
                structuredContent: {
                    fileName: path.basename(resolvedEditPath),
                    filePath: resolvedEditPath,
                    fileType: resolvePreviewFileType(resolvedEditPath),
                    ...await getDefaultEditorMetadata(resolvedEditPath),
                },
            } : {}),
        };
    }
    
    
    if (count > 0 && count !== expectedReplacements) {
        capture('server_edit_block_unexpected_count', {fileExtension: fileExtension, expectedReplacements, expectedReplacementsCount: count});
        return {
            content: [{ 
                type: "text", 
                text: `Expected ${expectedReplacements} occurrences but found ${count} in ${filePath}. ` + 
            `Double check and make sure you understand all occurencies and if you want to replace all ${count} occurrences, set expected_replacements to ${count}. ` +
            `If there are many occurrancies and you want to change some of them and keep the rest. Do it one by one, by adding more lines around each occurrence.` +
`If you want to replace a specific occurrence, make your search string more unique by adding more lines around search string.`
            }],
        };
    }
    
    
    if (count === 0) {
        
        const startTime = performance.now();

        
        
        const fuzzyResult = await runFuzzySearchInWorker(capture, content, block.search);
        const similarity = getSimilarityRatio(block.search, fuzzyResult.value);
        
        
        const executionTime = performance.now() - startTime;
        
        
        const diff = highlightDifferences(block.search, fuzzyResult.value);
        
        
        const characterCodeData = getCharacterCodeData(block.search, fuzzyResult.value);
        
        
        const logEntry: FuzzySearchLogEntry = {
            timestamp: new Date(),
            searchText: block.search,
            foundText: fuzzyResult.value,
            similarity: similarity,
            executionTime: executionTime,
            exactMatchCount: count,
            expectedReplacements: expectedReplacements,
            fuzzyThreshold: FUZZY_THRESHOLD,
            belowThreshold: similarity < FUZZY_THRESHOLD,
            diff: diff,
            searchLength: block.search.length,
            foundLength: fuzzyResult.value.length,
            fileExtension: fileExtension,
            characterCodes: characterCodeData.report,
            uniqueCharacterCount: characterCodeData.uniqueCount,
            diffLength: characterCodeData.diffLength
        };
        
        
        await fuzzySearchLogger.log(logEntry);
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        const fuzzySearchData = {
            similarity: similarity,
            execution_time_ms: executionTime,
            search_length: block.search.length,
            file_size: content.length,
            threshold: FUZZY_THRESHOLD,
            found_text_length: fuzzyResult.value.length,
            unique_character_count: characterCodeData.uniqueCount,
            total_diff_length: characterCodeData.diffLength
        };
        
        
        if (similarity >= FUZZY_THRESHOLD) {
            
            capture('server_fuzzy_search_performed', fuzzySearchData);
            
            
            
            return {
                content: [{ 
                    type: "text", 
                    text: `Exact match not found, but found a similar text with ${Math.round(similarity * 100)}% similarity (found in ${executionTime.toFixed(2)}ms):\n\n` +
                          `Differences:\n${diff}\n\n` +
                          `To replace this text, use the exact text found in the file.\n\n` +
                          `Log entry saved for analysis. Use the following command to check the log:\n` +
                          `Check log: ${await fuzzySearchLogger.getLogPath()}`
                }],// TODO
            };
        } else {
            
            
            capture('server_fuzzy_search_performed', {
                ...fuzzySearchData,
                below_threshold: true
            });
            
            return {
                content: [{ 
                    type: "text", 
                    text: `Search content not found in ${filePath}. The closest match was "${fuzzyResult.value}" ` +
                          `with only ${Math.round(similarity * 100)}% similarity, which is below the ${Math.round(FUZZY_THRESHOLD * 100)}% threshold. ` +
                          `(Fuzzy search completed in ${executionTime.toFixed(2)}ms)\n\n` +
                          `Log entry saved for analysis. Use the following command to check the log:\n` +
                          `Check log: ${await fuzzySearchLogger.getLogPath()}`
                }],
            };
        }
    }
    
    throw new Error("Unexpected error during search and replace operation.");
}

/**
 * Generates a character-level diff using standard {-removed-}{+added+} format
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns A formatted string showing character-level differences
 */
function highlightDifferences(expected: string, actual: string): string {
    
    
    
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    
    const commonPrefix = expected.substring(0, prefixLength);
    const commonSuffix = expected.substring(expected.length - suffixLength);

    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);

    
    return `${commonPrefix}{-${expectedDiff}-}{+${actualDiff}+}${commonSuffix}`;
}

/**
 * Handle edit_block command
 *
 * Text files: String replacement (old_string/new_string)
 *    - Uses fuzzy matching for resilience
 *    - Handles expected_replacements parameter
 *
 * Structured files (Excel): Range rewrite (range + content)
 *    - Bulk updates to cell ranges (e.g., "Sheet1!A1:C10")
 *    - Whole sheet replacement (e.g., "Sheet1")
 *    - More powerful and simpler than surgical location-based edits
 *    - Supports chunking for large datasets (e.g., 1000 rows at a time)

 */
export async function handleEditBlock(args: unknown, dependencies: EditDependencies): Promise<ServerResult> {
    const parsed = EditBlockArgsSchema.parse(args);

    
    const hasRange = parsed.range !== undefined && parsed.range !== '';
    const hasContent = parsed.content !== undefined && parsed.content !== '';

    
    let validatedPath: string;
    let handler: FileHandler;
    try {
        validatedPath = await validatePath(dependencies, parsed.file_path);
        handler = await dependencies.fileHandlers.getFileHandler(validatedPath);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage, dependencies.capture);
    }

    const hasEditRange = 'editRange' in handler && typeof handler.editRange === 'function';

    
    if (hasRange && hasContent) {
        
        let content = parsed.content;
        if (typeof content === 'string') {
            try {
                content = JSON.parse(content);
            } catch {
                // Leave as-is if not valid JSON - let handler decide
            }
        }

        if (hasEditRange) {
            try {
                
                await handler.editRange!(validatedPath!, parsed.range!, content, parsed.options);
                const resolvedRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated range ${parsed.range} in ${parsed.file_path}`
                    }],
                    ...(parsed.origin === 'ui' ? {
                        structuredContent: {
                            fileName: path.basename(resolvedRangePath),
                            filePath: resolvedRangePath,
                            fileType: resolvePreviewFileType(resolvedRangePath),
                            ...await getDefaultEditorMetadata(resolvedRangePath),
                        },
                    } : {}),
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return createErrorResponse(errorMessage, dependencies.capture);
            }
        }

        return createErrorResponse(`Range-based editing not supported for ${parsed.file_path}. For text files, use old_string and new_string parameters instead. If your client requires range/content parameters, set them to empty strings ("").`, dependencies.capture);
    }

    
    if (parsed.old_string === undefined || parsed.new_string === undefined) {
        return createErrorResponse(`Text replacement requires both old_string and new_string parameters`, dependencies.capture);
    }

    
    
    
    if (hasEditRange) {
        try {
            const result = await handler.editRange!(validatedPath!, '', {
                old_string: parsed.old_string,
                new_string: parsed.new_string,
                expected_replacements: parsed.expected_replacements,
            });

            if (result.success) {
                const resolvedEditRangePath = resolveAbsolutePath(parsed.file_path);
                return {
                    content: [{
                        type: "text",
                        text: `Successfully applied ${result.editsApplied} edit(s) to ${parsed.file_path}`
                    }],
                    ...(parsed.origin === 'ui' ? {
                        structuredContent: {
                            fileName: path.basename(resolvedEditRangePath),
                            filePath: resolvedEditRangePath,
                            fileType: resolvePreviewFileType(resolvedEditRangePath),
                            ...await getDefaultEditorMetadata(resolvedEditRangePath),
                        },
                    } : {}),
                };
            }

            const errorMsg = result.errors?.map(e => e.error).join('; ') || 'Unknown error';
            return createErrorResponse(errorMsg, dependencies.capture);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return createErrorResponse(errorMessage, dependencies.capture);
        }
    }

    return performSearchReplace(dependencies, parsed.file_path, {
        search: parsed.old_string,
        replace: parsed.new_string
    }, parsed.expected_replacements, parsed.origin);
}
