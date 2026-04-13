/**
 * Extract text from a PDF buffer using pdfjs-dist.
 * This is a standalone module with no BullMQ or node-tesseract-ocr dependencies,
 * safe to import in Next.js API routes.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
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
