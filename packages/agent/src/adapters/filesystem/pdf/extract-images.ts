import { getDocumentProxy, extractImages } from 'unpdf';
import { DEFAULT_PDF_IMAGE_BATCH_SIZE, type TextLogPort } from 'brc-shared';

export interface ImageInfo {
    /** Object ID within PDF */
    objId: number;
    width: number;
    height: number;
    /** Raw image data as base64 */
    data: string;
    /** MIME type of the image */
    mimeType: string;
    /** Original size in bytes before compression */
    originalSize?: number;
    /** Compressed size in bytes */
    compressedSize?: number;
}

export interface PageImages {
    pageNumber: number;
    images: ImageInfo[];
}

export interface ImageCompressionOptions {
    /** Output format: 'jpeg' | 'webp' */
    format?: 'jpeg' | 'webp';
    /** Quality for lossy formats (0-100, default 85) */
    quality?: number;
    /** Maximum dimension to resize to (maintains aspect ratio) */
    maxDimension?: number;
    /** Number of PDF pages processed per batch */
    batchSize?: number;
}

/**
 * Optimized image extraction from PDF using unpdf's built-in extractImages method
 * @param pdfBuffer PDF file as Uint8Array
 * @param pageNumbers Optional array of specific page numbers to process
 * @param compressionOptions Image compression settings
 * @returns Record of page numbers to extracted images
 */
export async function extractImagesFromPdf(
    pdfBuffer: Uint8Array,
    pageNumbers: number[] | undefined,
    compressionOptions: ImageCompressionOptions,
    log: TextLogPort,
): Promise<Record<number, ImageInfo[]>> {
    const pdfDocument = await getDocumentProxy(pdfBuffer);

    const pagesToProcess = pageNumbers || Array.from({ length: pdfDocument.numPages }, (_, i) => i + 1);

    const pageResults: Record<number, ImageInfo[]> = {};

    try {

        const batchSize = compressionOptions.batchSize ?? DEFAULT_PDF_IMAGE_BATCH_SIZE;
        const batches: number[][] = [];
        for (let i = 0; i < pagesToProcess.length; i += batchSize) {
            batches.push(pagesToProcess.slice(i, i + batchSize));
        }

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            const batchPromises = batch.map(async (pageNum) => {
                if (pageNum < 1 || pageNum > pdfDocument.numPages) {
                    return { pageNum, images: [] };
                }

                try {

                    const extractedImages = await extractImages(pdfDocument, pageNum);

                    const pageImages: ImageInfo[] = [];

                    for (let index = 0; index < extractedImages.length; index++) {
                        const img = extractedImages[index];
                        const originalSize = img.data.length;

                        try {
                            const compressionResult = await convertRawImageToBase64(
                                img.data,
                                img.width,
                                img.height,
                                img.channels,
                                compressionOptions,
                                log
                            );

                            if (compressionResult) {
                                pageImages.push({
                                    objId: index,
                                    width: img.width,
                                    height: img.height,
                                    data: compressionResult.data,
                                    mimeType: compressionResult.mimeType,
                                    originalSize,
                                    compressedSize: Math.round(compressionResult.data.length * 0.75) 
                                });
                            }
                        } catch (err) {

                            log.warning(`Failed to convert image ${index} on page ${pageNum}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }

                    return { pageNum, images: pageImages };
                } catch (error) {
                    log.warning(`Failed to extract images from page ${pageNum}: ${error instanceof Error ? error.message : String(error)}`);
                    return { pageNum, images: [] };
                }
            });


            const batchResults = await Promise.all(batchPromises);


            for (const { pageNum, images } of batchResults) {
                pageResults[pageNum] = images;
            }
        }
    } finally {

        try {
            if (typeof pdfDocument.cleanup === 'function') {
                await pdfDocument.cleanup(false);
            }
        } catch (e) { }
        try {
            if (typeof (pdfDocument as any).destroy === 'function') {
                await (pdfDocument as any).destroy();
            }
        } catch (e) { }
    }

    return pageResults;
}

/**
 * Convert raw image data to compressed base64 using sharp
 */
async function convertRawImageToBase64(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    channels: number,
    options: ImageCompressionOptions,
    log: TextLogPort,
): Promise<{ data: string; mimeType: string } | null> {
    const {
        format = 'webp',
        quality = 85,
        maxDimension = 1200
    } = options;


    let targetWidth = width;
    let targetHeight = height;

    if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        targetWidth = Math.round(width * scale);
        targetHeight = Math.round(height * scale);
    }

    try {

        const sharp = (await import('sharp')).default;



        let pipeline = sharp(Buffer.from(data), {
            raw: {
                width,
                height,
                channels: channels as 1 | 2 | 3 | 4
            }
        });

        if (targetWidth !== width || targetHeight !== height) {
            pipeline = pipeline.resize(targetWidth, targetHeight);
        }

        let outputBuffer: Buffer;
        let mimeType: string;

        if (format === 'jpeg') {
            outputBuffer = await pipeline.jpeg({ quality }).toBuffer();
            mimeType = 'image/jpeg';
        } else {

            outputBuffer = await pipeline.webp({ quality }).toBuffer();
            mimeType = 'image/webp';
        }

        return {
            data: outputBuffer.toString('base64'),
            mimeType
        };
    } catch (error) {
        log.warning(`Image conversion failed (likely missing sharp or invalid data): ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}