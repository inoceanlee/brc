import { z } from "zod";


export const GetConfigArgsSchema = z.object({
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]),
  
  origin: z.enum(['ui', 'llm']).optional(),
});


export const ListProcessesArgsSchema = z.object({});


export const StartProcessArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number(),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
  offset: z.number().optional(),   // Line offset: 0=from last read, positive=absolute, negative=tail
  length: z.number().optional(),   // Max lines to return (default from config.fileReadLineLimit)
  verbose_timing: z.boolean().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});


export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional(),
  sheet: z.string().optional(),  // String only for MCP client compatibility (Cursor doesn't support union types in JSON Schema)
  range: z.string().optional(),
  options: z.record(z.any()).optional(),
  
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});


export const PdfInsertOperationSchema = z.object({
  type: z.literal('insert'),
  pageIndex: z.number(),
  markdown: z.string().optional(),
  sourcePdfPath: z.string().optional(),
  pdfOptions: z.object({}).passthrough().optional(),
});

export const PdfDeleteOperationSchema = z.object({
  type: z.literal('delete'),
  pageIndexes: z.array(z.number()),
});

export const PdfOperationSchema = z.union([PdfInsertOperationSchema, PdfDeleteOperationSchema]);

export const WritePdfArgsSchema = z.object({
  path: z.string(),
  
  content: z.preprocess(
    (val) => {
      
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          
          return val;
        }
      }
      
      return val;
    },
    z.union([z.string(), z.array(PdfOperationSchema)])
  ),
  outputPath: z.string().optional(),
  options: z.object({}).passthrough().optional(), // Allow passing options to md-to-pdf
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
  depth: z.number().optional().default(2),
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const PrepareFileTransferArgsSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(7200).optional().default(3600),
});

export const SendFileTransferArgsSchema = z.object({
  sourcePath: z.string(),
  recipientPublicKey: z.string().min(16),
  expireSeconds: z.number().int().min(60).max(7200).optional().default(3600),
});

export const ReceiveFileTransferArgsSchema = z.object({
  receiveId: z.string().min(16),
  transferToken: z.string().min(32),
  destinationPath: z.string(),
  overwrite: z.boolean().optional().default(false),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});






export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  expected_replacements: z.number().optional().default(1),
  
  range: z.string().optional(),
  content: z.any().optional(),
  options: z.record(z.any()).optional(),
  
  
  origin: z.enum(['ui', 'llm']).optional(),
}).refine(
  data => {
    
    const hasValue = (v: unknown) => v !== undefined && v !== '';
    return (hasValue(data.old_string) && data.new_string !== undefined) ||
           (hasValue(data.range) && hasValue(data.content));
  },
  { message: "Must provide either (old_string + new_string) or (range + content)" }
);


export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
});


export const GetUsageStatsArgsSchema = z.object({});


export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});


export const StartSearchArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  searchType: z.enum(['files', 'content']).default('files'),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().optional().default(5),
  timeout_ms: z.number().optional(), // Match process naming convention
  earlyTermination: z.boolean().optional(), // Stop search early when exact filename match is found (default: true for files, false for content)
  literalSearch: z.boolean().optional().default(false), // Force literal string matching (-F flag) instead of regex
  
  
  origin: z.enum(['ui', 'llm']).optional(),
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string(),
  offset: z.number().optional().default(0),    // Same as file reading
  length: z.number().optional().default(100),  // Same as file reading (but smaller default)
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string(),
});

export const ListSearchesArgsSchema = z.object({});


export const GetPromptsArgsSchema = z.object({
  action: z.enum(['get_prompt']),
  promptId: z.string(),
  // Disabled to check if it makes sense or should be removed or changed
  // anonymous_user_use_case: z.string().optional(),
});


export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
});

export const TrackUiEventArgsSchema = z.object({
  event: z.string().min(1).max(80),
  component: z.string().optional().default('file_preview'),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
});

/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export const toolArgSchemas: Record<string, z.ZodTypeAny> = {
  get_config: GetConfigArgsSchema,
  set_config_value: SetConfigValueArgsSchema,
  read_file: ReadFileArgsSchema,
  read_multiple_files: ReadMultipleFilesArgsSchema,
  write_file: WriteFileArgsSchema,
  write_pdf: WritePdfArgsSchema,
  create_directory: CreateDirectoryArgsSchema,
  list_directory: ListDirectoryArgsSchema,
  move_file: MoveFileArgsSchema,
  prepare_file_transfer: PrepareFileTransferArgsSchema,
  send_file_transfer: SendFileTransferArgsSchema,
  receive_file_transfer: ReceiveFileTransferArgsSchema,
  start_search: StartSearchArgsSchema,
  get_more_search_results: GetMoreSearchResultsArgsSchema,
  stop_search: StopSearchArgsSchema,
  list_searches: ListSearchesArgsSchema,
  get_file_info: GetFileInfoArgsSchema,
  edit_block: EditBlockArgsSchema,
  start_process: StartProcessArgsSchema,
  read_process_output: ReadProcessOutputArgsSchema,
  interact_with_process: InteractWithProcessArgsSchema,
  force_terminate: ForceTerminateArgsSchema,
  list_sessions: ListSessionsArgsSchema,
  list_processes: ListProcessesArgsSchema,
  kill_process: KillProcessArgsSchema,
  get_usage_stats: GetUsageStatsArgsSchema,
  get_recent_tool_calls: GetRecentToolCallsArgsSchema,
  give_feedback_to_desktop_commander: GiveFeedbackArgsSchema,
  get_prompts: GetPromptsArgsSchema,
  track_ui_event: TrackUiEventArgsSchema,
};