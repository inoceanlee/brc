import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { validatePath, type FilesystemDependencies } from '../filesystem/filesystem.js';
import { getRipgrepPath } from './ripgrep-resolver.js';
import PizZip from 'pizzip';

export interface SearchResult {
  file: string;
  line?: number;
  match?: string;
  type: 'file' | 'content';
}

export interface SearchSession {
  id: string;
  process: ChildProcess;
  results: SearchResult[];
  isComplete: boolean;
  isError: boolean;
  error?: string;
  startTime: number;
  lastReadTime: number;
  options: SearchSessionOptions;
  buffer: string;  
  totalMatches: number;
  totalContextLines: number;  
  wasIncomplete?: boolean;  
}

export interface SearchSessionOptions {
  rootPath: string;
  pattern: string;
  searchType: 'files' | 'content';
  filePattern?: string;
  ignoreCase?: boolean;
  maxResults?: number;
  includeHidden?: boolean;
  contextLines?: number;
  timeout?: number;
  earlyTermination?: boolean;  
  literalSearch?: boolean;     
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */
export class SearchManager {
  private sessions = new Map<string, SearchSession>();
  private sessionCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private initialCleanupTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly backgroundSearches = new Set<Promise<void>>();

  constructor(private readonly dependencies: FilesystemDependencies) {}

  private startCleanupIfNeeded(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
    this.initialCleanupTimer = setTimeout(() => {
      this.initialCleanupTimer = null;
      this.cleanupSessions();
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.cleanupInterval ?? undefined);
    clearTimeout(this.initialCleanupTimer ?? undefined);
    this.cleanupInterval = null;
    this.initialCleanupTimer = null;
    for (const session of this.sessions.values()) {
      if (!session.isComplete && !session.process.killed) session.process.kill('SIGTERM');
    }
    this.sessions.clear();
    await Promise.allSettled([...this.backgroundSearches]);
  }

  /**
   * Start a new search session (like start_process)
   * Returns immediately with initial state and results
   */

  async startSearch(options: SearchSessionOptions): Promise<{
    sessionId: string;
    isComplete: boolean;
    isError: boolean;
    results: SearchResult[];
    totalResults: number;
    runtime: number;
  }> {
    if (this.stopped) throw new Error('Search manager is stopped.');
    const sessionId = `search_${++this.sessionCounter}_${Date.now()}`;


    const validPath = await validatePath(this.dependencies, options.rootPath);
    if (this.stopped) throw new Error('Search manager is stopped.');


    const args = this.buildRipgrepArgs({ ...options, rootPath: validPath });


    let rgPath: string;
    try {
      rgPath = await getRipgrepPath();
    } catch (err) {
      throw new Error(`Failed to locate ripgrep binary: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.stopped) throw new Error('Search manager is stopped.');


    const rgProcess = spawn(rgPath, args, { windowsHide: true });  

    if (!rgProcess.pid) {
      throw new Error('Failed to start ripgrep process');
    }


    const session: SearchSession = {
      id: sessionId,
      process: rgProcess,
      results: [],
      isComplete: false,
      isError: false,
      startTime: Date.now(),
      lastReadTime: Date.now(),
      options,
      buffer: '',
      totalMatches: 0,
      totalContextLines: 0
    };

    this.sessions.set(sessionId, session);


    this.setupProcessHandlers(session);


    this.startCleanupIfNeeded();



    const timeoutMs = options.timeout ?? (this.isExactFilename(options.pattern) ? 1500 : undefined);

    let killTimer: NodeJS.Timeout | null = null;
    if (timeoutMs) {
      killTimer = setTimeout(() => {
        if (!session.isComplete && !session.process.killed) {
          session.process.kill('SIGTERM');
        }
      }, timeoutMs);
    }


    session.process.once('close', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    session.process.once('error', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    this.dependencies.capture('search_session_started', {
      sessionId,
      searchType: options.searchType,
      hasTimeout: !!timeoutMs,
      timeoutMs,
      requestedPath: options.rootPath,
      validatedPath: validPath
    });




    const shouldSearchExcel = options.searchType === 'content' &&
      this.shouldIncludeExcelSearch(options.filePattern, validPath);

    if (shouldSearchExcel) {
      const background = this.searchExcelFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,
        options.literalSearch  
      ).then(excelResults => {

        for (const result of excelResults) {
          session.results.push(result);
          session.totalMatches++;
        }
      }).catch((err) => {

        this.dependencies.capture('excel_search_error', { error: err instanceof Error ? err.message : String(err) });
      });
      this.backgroundSearches.add(background);
      void background.then(() => this.backgroundSearches.delete(background), () => this.backgroundSearches.delete(background));
    }


    const shouldSearchDocx = options.searchType === 'content' &&
      this.shouldIncludeDocxSearch(options.filePattern, validPath);

    if (shouldSearchDocx) {
      const background = this.searchDocxFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,
        options.literalSearch  
      ).then(docxResults => {
        for (const result of docxResults) {
          session.results.push(result);
          session.totalMatches++;
        }
      }).catch((err) => {
        this.dependencies.capture('docx_search_error', { error: err instanceof Error ? err.message : String(err) });
      });
      this.backgroundSearches.add(background);
      void background.then(() => this.backgroundSearches.delete(background), () => this.backgroundSearches.delete(background));
    }



    const firstChunk = new Promise<void>(resolve => {
      const onData = () => {
        session.process.stdout?.off('data', onData);
        resolve();
      };
      session.process.stdout?.once('data', onData);
      setTimeout(resolve, 40); 
    });


    await firstChunk;

    return {
      sessionId,
      isComplete: session.isComplete,
      isError: session.isError,
      results: [...session.results],
      totalResults: session.totalMatches,
      runtime: Date.now() - session.startTime
    };
  }

  /**
   * Read search results with offset-based pagination (like read_file)
   * Supports both range reading and tail behavior
   */
  readSearchResults(
    sessionId: string, 
    offset: number = 0, 
    length: number = 100
  ): {
    results: SearchResult[];
    returnedCount: number;        
    totalResults: number;
    totalMatches: number;         
    isComplete: boolean;
    isError: boolean;
    error?: string;
    hasMoreResults: boolean;      
    runtime: number;
    wasIncomplete?: boolean;      
  } {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }


    const allResults = session.results.filter(r => r.file !== '__LAST_READ_MARKER__');


    if (offset < 0) {
      const tailCount = Math.abs(offset);
      const tailResults = allResults.slice(-tailCount);
      return {
        results: tailResults,
        returnedCount: tailResults.length,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches,
        isComplete: session.isComplete,
        isError: session.isError && !!session.error?.trim(),
        error: session.error?.trim() || undefined,
        hasMoreResults: false,
        runtime: Date.now() - session.startTime,
        wasIncomplete: session.wasIncomplete
      };
    }


    const slicedResults = allResults.slice(offset, offset + length);
    const hasMoreResults = offset + length < allResults.length || !session.isComplete;

    session.lastReadTime = Date.now();

    return {
      results: slicedResults,
      returnedCount: slicedResults.length,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches,
      isComplete: session.isComplete,
      isError: session.isError && !!session.error?.trim(),
      error: session.error?.trim() || undefined,
      hasMoreResults,
      runtime: Date.now() - session.startTime,
      wasIncomplete: session.wasIncomplete
    };
  }

  /**
   * Terminate a search session (like force_terminate)
   */
  terminateSearch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    if (!session.process.killed) {
      session.process.kill('SIGTERM');
    }




    return true;
  }

  /**
   * Get list of active search sessions (like list_sessions)
   */
  listSearchSessions(): Array<{
    id: string;
    searchType: string;
    pattern: string;
    isComplete: boolean;
    isError: boolean;
    runtime: number;
    totalResults: number;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      searchType: session.options.searchType,
      pattern: session.options.pattern,
      isComplete: session.isComplete,
      isError: session.isError,
      runtime: Date.now() - session.startTime,
      totalResults: session.totalMatches + session.totalContextLines
    }));
  }

  /**
   * Search Excel files for content matches
   * Called during content search to include Excel files alongside text files
   * Searches ALL sheets in each Excel file (row-wise for cross-column matching)
   *
   * TODO: Refactor - Extract Excel search logic to separate module (src/utils/search/excel-search.ts)
   * and inject into SearchManager, similar to how file handlers are structured in src/utils/files/
   * This would allow adding other file type searches (PDF, etc.) without bloating search-manager.ts
   */
  private async searchExcelFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];



    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;


    let excelFiles = await this.findExcelFiles(rootPath);


    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      excelFiles = excelFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {

          if (pat.includes('*')) {




            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') 
              .replace(/\*/g, '.*');                  
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }

          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }


    const ExcelJS = await import('exceljs');

    for (const filePath of excelFiles) {
      if (maxResults && results.length >= maxResults) break;

      try {
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);


        for (const worksheet of workbook.worksheets) {
          if (maxResults && results.length >= maxResults) break;

          const sheetName = worksheet.name;


          worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (maxResults && results.length >= maxResults) return;


            const rowValues: string[] = [];
            row.eachCell({ includeEmpty: false }, (cell) => {
              if (cell.value === null || cell.value === undefined) return;

              let cellStr: string;
              if (typeof cell.value === 'object') {
                if ('result' in cell.value) {
                  cellStr = String(cell.value.result ?? '');
                } else if ('richText' in cell.value) {
                  cellStr = (cell.value as any).richText.map((rt: any) => rt.text).join('');
                } else if ('text' in cell.value) {
                  cellStr = String((cell.value as any).text);
                } else {
                  cellStr = String(cell.value);
                }
              } else {
                cellStr = String(cell.value);
              }

              if (cellStr.trim()) {
                rowValues.push(cellStr);
              }
            });


            const rowText = rowValues.join(' ');

            const textToSearch = ignoreCase ? rowText.toLowerCase() : rowText;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(rowText, matchIndex, searchTerm.length);

              results.push({
                file: `${filePath}:${sheetName}!Row${rowNumber}`,
                line: rowNumber,
                match: matchContext,
                type: 'content'
              });
            }
          });
        }
      } catch (error) {

        continue;
      }
    }

    return results;
  }

  /**
   * Find all Excel files in a directory recursively
   */
  private async findExcelFiles(rootPath: string): Promise<string[]> {
    const fileHandlers = this.dependencies.fileHandlers;
    const excelFiles: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {

            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && fileHandlers.isExcelFile(entry.name)) {
            excelFiles.push(fullPath);
          }
        }
      } catch {

      }
    }


    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && fileHandlers.isExcelFile(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch {

    }

    return excelFiles;
  }

  /**
   * Determine if DOCX search should be included based on context
   */
  private shouldIncludeDocxSearch(filePattern?: string, rootPath?: string): boolean {
    const docxExtensions = ['.docx'];

    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (docxExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      if (docxExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) || lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search DOCX files for content matches
   * Extracts <w:t> text from document.xml and searches it
   */
  private async searchDocxFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];



    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    let docxFiles = await this.findDocxFiles(rootPath);

    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      docxFiles = docxFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          if (pat.includes('*')) {
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') 
              .replace(/\*/g, '.*');                  
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    for (const filePath of docxFiles) {
      if (maxResults && results.length >= maxResults) break;

      try {
        const buf = await fs.readFile(filePath);
        const zip = new PizZip(buf);


        const xmlParts = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
          'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];

        for (const xmlPath of xmlParts) {
          if (maxResults && results.length >= maxResults) break;

          const file = zip.file(xmlPath);
          if (!file) continue;

          const xml = file.asText();

          const wtRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
          let m;
          let lineNum = 0;

          while ((m = wtRe.exec(xml)) !== null) {
            if (maxResults && results.length >= maxResults) break;
            const text = m[1];
            if (!text || !text.trim()) continue;
            lineNum++;

            const textToSearch = ignoreCase ? text.toLowerCase() : text;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(text, matchIndex, searchTerm.length);

              const partName = xmlPath === 'word/document.xml' ? '' : `:${xmlPath.replace('word/', '')}`;
              results.push({
                file: `${filePath}${partName}`,
                line: lineNum,
                match: matchContext,
                type: 'content'
              });
            }
          }
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  /**
   * Find all DOCX files in a directory recursively
   */
  private async findDocxFiles(rootPath: string): Promise<string[]> {
    const docxFiles: string[] = [];
    const isDocx = (name: string) => name.toLowerCase().endsWith('.docx');

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isDocx(entry.name)) {
            docxFiles.push(fullPath);
          }
        }
      } catch { }
    }

    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && isDocx(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch { }

    return docxFiles;
  }

  /**
   * Extract context around a match for display (show surrounding text)
   */
  private getMatchContext(text: string, matchStart: number, matchLength: number): string {
    const contextChars = 50; 
    const start = Math.max(0, matchStart - contextChars);
    const end = Math.min(text.length, matchStart + matchLength + contextChars);

    let context = text.substring(start, end);


    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    return context;
  }

  /**
   * Clean up completed sessions older than specified time
   * Called automatically by cleanup interval
   */
  cleanupSessions(maxAge: number = 5 * 60 * 1000): void {
    const cutoffTime = Date.now() - maxAge;

    for (const [sessionId, session] of this.sessions) {
      if (session.isComplete && session.lastReadTime < cutoffTime) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Get total number of active sessions (excluding completed ones)
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(session => !session.isComplete).length;
  }

  /**
   * Detect if pattern looks like an exact filename
   * (has file extension and no glob wildcards)
   */
  private isExactFilename(pattern: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(pattern) &&
           !this.isGlobPattern(pattern);
  }

  /**
   * Detect if pattern contains glob wildcards
   */
  private isGlobPattern(pattern: string): boolean {
    return pattern.includes('*') ||
           pattern.includes('?') ||
           pattern.includes('[') ||
           pattern.includes('{') ||
           pattern.includes(']') ||
           pattern.includes('}');
  }

  /**
   * Determine if Excel search should be included based on context
   * Only searches Excel files when:
   * - filePattern explicitly targets Excel files (*.xlsx, *.xls, *.xlsm, *.xlsb)
   * - or the rootPath itself is an Excel file
   */
  private shouldIncludeExcelSearch(filePattern?: string, rootPath?: string): boolean {
    const excelExtensions = ['.xlsx', '.xls', '.xlsm', '.xlsb'];


    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (excelExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }


    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();

      if (excelExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) ||
        lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    const args: string[] = [];

    if (options.searchType === 'content') {

      args.push('--json', '--line-number');


      if (options.literalSearch) {
        args.push('-F'); 
      }

      if (options.contextLines && options.contextLines > 0) {
        args.push('-C', options.contextLines.toString());
      }
    } else {

      args.push('--files');
    }


    if (options.searchType === 'content' && options.ignoreCase !== false) {
      args.push('-i');
    }

    if (options.includeHidden) {
      args.push('--hidden');
    }

    if (options.maxResults && options.maxResults > 0) {
      args.push('-m', options.maxResults.toString());
    }


    if (options.filePattern) {
      const patterns = options.filePattern
        .split('|')
        .map(p => p.trim())
        .filter(Boolean);

      for (const p of patterns) {
        if (options.searchType === 'content') {
          args.push('-g', p);
        } else {

          if (options.ignoreCase !== false) {
            args.push('--iglob', p);
          } else {
            args.push('--glob', p);
          }
        }
      }
    }


    if (options.searchType === 'files') {

      const globFlag = options.ignoreCase !== false ? '--iglob' : '--glob';

      if (this.isExactFilename(options.pattern)) {

        args.push(globFlag, options.pattern);
      } else if (this.isGlobPattern(options.pattern)) {

        args.push(globFlag, options.pattern);
      } else {

        args.push(globFlag, `*${options.pattern}*`);
      }

      args.push(options.rootPath);
    } else {


      args.push('--', options.pattern, options.rootPath);
    }

    return args;
  }

  private setupProcessHandlers(session: SearchSession): void {
    const { process } = session;

    process.stdout?.on('data', (data: Buffer) => {
      session.buffer += data.toString();
      this.processBufferedOutput(session);
    });

    process.stderr?.on('data', (data: Buffer) => {
      const errorText = data.toString();



      session.error = (session.error || '') + errorText;


      const filteredErrors = errorText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();


          if (!trimmed || trimmed.match(/^[\)\(\s\d:]*$/)) return false;


          if (trimmed.startsWith('rg:')) return false;

          return true;
        });


      if (filteredErrors.length > 0) {
        const meaningfulErrors = filteredErrors.join('\n').trim();
        if (meaningfulErrors) {
          session.error = (session.error || '') + meaningfulErrors + '\n';
          this.dependencies.capture('search_session_error', {
            sessionId: session.id,
            error: meaningfulErrors.substring(0, 200)
          });
        }
      }
    });

    process.on('close', (code: number) => {

      if (session.buffer.trim()) {
        this.processBufferedOutput(session, true);
      }

      session.isComplete = true;



      if (code === 2) {
        session.wasIncomplete = true;
      }





      if (code !== 0 && code !== 1 && code !== 2) {

        if (session.error?.trim() && session.totalMatches === 0) {
          session.isError = true;
          session.error = session.error || `ripgrep exited with code ${code}`;
        }
      }


      if (session.totalMatches > 0) {
        session.isError = false;
      }

      this.dependencies.capture('search_session_completed', {
        sessionId: session.id,
        exitCode: code,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches,
        runtime: Date.now() - session.startTime,
        wasIncomplete: session.wasIncomplete || false  
      });


    });

    process.on('error', (error: Error) => {
      session.isComplete = true;
      session.isError = true;
      session.error = `Process error: ${error.message}`;


    });
  }

  private processBufferedOutput(session: SearchSession, isFinal: boolean = false): void {
    const lines = session.buffer.split('\n');


    if (!isFinal) {
      session.buffer = lines.pop() || '';
    } else {
      session.buffer = '';
    }

    for (const line of lines) {
      if (!line.trim()) continue;

      const result = this.parseLine(line, session.options.searchType);
      if (result) {
        session.results.push(result);

        if (result.type === 'content' && line.includes('"type":"context"')) {
          session.totalContextLines++;
        } else {
          session.totalMatches++;
        }


        if (session.options.earlyTermination !== false && 
            session.options.searchType === 'files' &&
            this.isExactFilename(session.options.pattern)) {
          const pat = path.normalize(session.options.pattern);
          const filePath = path.normalize(result.file);
          const ignoreCase = session.options.ignoreCase !== false;
          const ends = ignoreCase
            ? filePath.toLowerCase().endsWith(pat.toLowerCase())
            : filePath.endsWith(pat);
          if (ends) {

            setTimeout(() => {
              if (!session.process.killed) {
                session.process.kill('SIGTERM');
              }
            }, 100); 
            break;
          }
        }
      }
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): SearchResult | null {
    if (searchType === 'content') {

      try {
        const parsed = JSON.parse(line);

        if (parsed.type === 'match') {

          const submatch = parsed.data?.submatches?.[0];
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: submatch?.match?.text || parsed.data.lines.text,
            type: 'content'
          };
        }

        if (parsed.type === 'context') {
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: parsed.data.lines.text.trim(),
            type: 'content'
          };
        }


        if (parsed.type === 'summary') {

          return null;
        }

        return null;
      } catch (error) {

        return null;
      }
    } else {

      return {
        file: line.trim(),
        type: 'file'
      };
    }
  }
}

