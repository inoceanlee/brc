export type PreviewFileType = 'markdown' | 'text' | 'html' | 'image' | 'directory' | 'unsupported';

function suffixOf(value: string): string {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const name = value.slice(separator + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function nameOf(value: string): string {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value.slice(separator + 1);
}


export const MARKDOWN_PREVIEW_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
export const HTML_PREVIEW_EXTENSIONS = new Set(['.html', '.htm']);

export const TEXT_PREVIEW_EXTENSIONS = new Set([
    '.txt',
    '.text',
    '.log',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.xml',
    '.css',
    '.scss',
    '.less',
    '.js',
    '.cjs',
    '.mjs',
    '.ts',
    '.jsx',
    '.tsx',
    '.sh',
    '.bash',
    '.zsh',
    '.py',
    '.rb',
    '.java',
    '.go',
    '.rs',
    '.sql',
    '.srt',
    '.vtt'
]);

const TEXT_PREVIEW_BASENAMES = new Set([
    '.env',
    '.gitignore',
    '.gitattributes',
    'dockerfile',
    'makefile'
]);

export function resolvePreviewFileType(filePath: string): PreviewFileType {
    const normalizedPath = filePath.toLowerCase();
    const extension = suffixOf(normalizedPath);
    const basename = nameOf(normalizedPath);

    if (MARKDOWN_PREVIEW_EXTENSIONS.has(extension)) {
        return 'markdown';
    }
    if (HTML_PREVIEW_EXTENSIONS.has(extension)) {
        return 'html';
    }
    if (TEXT_PREVIEW_EXTENSIONS.has(extension) || TEXT_PREVIEW_BASENAMES.has(basename)) {
        return 'text';
    }
    return 'unsupported';
}
