export interface SearchExecutionRequest {
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

export interface SearchHit {
  file: string;
  line?: number;
  match?: string;
  type: 'file' | 'content';
}

export interface SearchExecutionSnapshot {
  sessionId: string;
  isComplete: boolean;
  isError: boolean;
  error?: string;
  results: SearchHit[];
  totalResults: number;
  runtime: number;
}

export interface SearchResultPage {
  results: SearchHit[];
  returnedCount: number;
  totalResults: number;
  totalMatches: number;
  isComplete: boolean;
  isError: boolean;
  error?: string;
  hasMoreResults: boolean;
  runtime: number;
  wasIncomplete?: boolean;
}

export interface SearchSessionSummary {
  id: string;
  searchType: string;
  pattern: string;
  isComplete: boolean;
  isError: boolean;
  runtime: number;
  totalResults: number;
}

export interface SearchExecutionPort {
  start(request: SearchExecutionRequest, signal?: AbortSignal): Promise<SearchExecutionSnapshot>;
  read(sessionId: string, offset?: number, length?: number): Promise<SearchResultPage>;
  cancel(sessionId: string): Promise<boolean>;
  list(): Promise<SearchSessionSummary[]>;
  prune(maxAgeMs: number, signal?: AbortSignal): Promise<number>;
}

export interface ToolHistoryEntry {
  timestamp: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
  output: { isError: boolean; content: readonly unknown[] };
  duration?: number;
}

export interface ToolHistoryQuery {
  maxResults?: number;
  toolName?: string;
  since?: string;
}

export interface ToolHistoryStorePort {
  append(entry: ToolHistoryEntry, signal?: AbortSignal): Promise<void>;
  query(query: ToolHistoryQuery, signal?: AbortSignal): Promise<ToolHistoryEntry[]>;
  prune(maxEntries: number, signal?: AbortSignal): Promise<number>;
  clear(signal?: AbortSignal): Promise<void>;
}

export interface CleanupIssue {
  path: string;
  reason: string;
}

export interface CleanupResult {
  removed: number;
  bytesRemoved: number;
  wouldRemove?: number;
  failures: CleanupIssue[];
  preserved: CleanupIssue[];
}

export interface CleanupPort {
  clean(paths: readonly string[], signal?: AbortSignal): Promise<CleanupResult>;
}
