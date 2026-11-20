/**
 * Factory pattern for creating appropriate file handlers
 * Routes file operations to the correct handler based on file type
 *
 * Each handler implements canHandle() which can be sync (extension-based)
 * or async (content-based like BinaryFileHandler using isBinaryFile)
 */

import type { FileHandler } from './base.js';
import type { TextFileHandler } from './text.js';
import type { ImageFileHandler } from './image.js';
import type { BinaryFileHandler } from './binary.js';
import type { ExcelFileHandler } from './excel.js';
import type { PdfFileHandler } from './pdf.js';
import type { DocxFileHandler } from './docx.js';

export class FileHandlerFactory {
    constructor(
        private readonly docx: DocxFileHandler,
        private readonly pdf: PdfFileHandler,
        private readonly excel: ExcelFileHandler,
        private readonly image: ImageFileHandler,
        private readonly binary: BinaryFileHandler,
        private readonly text: TextFileHandler,
    ) {}

/**
 * Get the appropriate file handler for a given file path
 *
 * Each handler's canHandle() determines if it can process the file.
 * Extension-based handlers (Excel, Image) return sync boolean.
 * BinaryFileHandler uses async isBinaryFile for content-based detection.
 *
 * Priority order:
 * DOCX files (extension based)
 * PDF files (extension based)
 * Excel files (xlsx, xls, xlsm) - extension based
 * Image files (png, jpg, gif, webp) - extension based
 * Binary files - content-based detection via isBinaryFile
 * Text files (default)
 *
 * @param filePath File path to get handler for
 * @returns FileHandler instance that can handle this file
 */
async getFileHandler(filePath: string): Promise<FileHandler> {
    
    if (this.docx.canHandle(filePath)) {
        return this.docx;
    }

    
    if (this.pdf.canHandle(filePath)) {
        return this.pdf;
    }

    
    if (this.excel.canHandle(filePath)) {
        return this.excel;
    }

    
    if (this.image.canHandle(filePath)) {
        return this.image;
    }

    
    if (await this.binary.canHandle(filePath)) {
        return this.binary;
    }

    
    return this.text;
}

/**
 * Check if a file path is an Excel file
 * Delegates to ExcelFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is Excel format
 */
isExcelFile(path: string): boolean {
    return this.excel.canHandle(path);
}

/**
 * Check if a file path is an image file
 * Delegates to ImageFileHandler.canHandle to avoid duplicating extension logic
 * @param path File path
 * @returns true if file is an image format
 */
isImageFile(path: string): boolean {
    return this.image.canHandle(path);
}
}
