/**
 * Extract text from a PDF buffer using pdfjs-dist.
 * This is a standalone module with no BullMQ or system-tesseract dependencies,
 * safe to import in Next.js API routes. OCR is deliberately NOT imported here:
 * callers that want a scanned-PDF fallback inject one through `options.ocr`, so
 * this module keeps the dependency shape the production bundle relies on.
 */

/** Where the returned text came from. `none` means nothing usable was found. */
export type PdfTextSource = 'text-layer' | 'ocr' | 'none';

export interface ExtractPdfTextOptions {
  /**
   * OCR of the raw PDF bytes, called only when the document has no usable text
   * layer. Injected by the caller — see `extractTextFromPdfViaOcr` in
   * `@/lib/queue/jobs/ocr-receipt` for the tesseract implementation.
   */
  ocr?: (buffer: Buffer) => Promise<string>;
}

export interface PdfTextResult {
  text: string;
  source: PdfTextSource;
  /** Why the fallback yielded nothing; null when text was extracted. */
  ocrError: string | null;
}

async function extractTextLayer(buffer: Buffer): Promise<string> {
  // Keep PDF.js external when bundling this module for Node. Its Node loader
  // uses import.meta.url to load the canvas polyfills and PDF worker; folding
  // pdf.mjs into a CommonJS bundle removes that module URL.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const textParts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: unknown) => (item as { str?: string }).str || '')
      .join(' ');
    textParts.push(pageText);
  }

  return textParts.join('\n').trim();
}

/**
 * Extract PDF text, falling back to the injected OCR hook for scanned and
 * image-only documents. Never throws for OCR problems — the caller gets an
 * explicit `source: 'none'` plus `ocrError` so it can record a failure state
 * instead of silently persisting empty text.
 */
export async function extractPdfText(
  buffer: Buffer,
  options: ExtractPdfTextOptions = {},
): Promise<PdfTextResult> {
  const directText = await extractTextLayer(buffer);
  if (directText) return { text: directText, source: 'text-layer', ocrError: null };

  if (!options.ocr) {
    return { text: '', source: 'none', ocrError: 'PDF has no text layer and no OCR fallback was provided' };
  }

  try {
    const ocrText = (await options.ocr(buffer)).trim();
    return ocrText
      ? { text: ocrText, source: 'ocr', ocrError: null }
      : { text: '', source: 'none', ocrError: 'PDF has no text layer and OCR produced no text' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { text: '', source: 'none', ocrError: `PDF has no text layer and OCR failed: ${detail}` };
  }
}

/** Text-only wrapper. Returns '' when nothing could be extracted. */
export async function extractTextFromPdf(
  buffer: Buffer,
  options?: ExtractPdfTextOptions,
): Promise<string> {
  return (await extractPdfText(buffer, options)).text;
}
