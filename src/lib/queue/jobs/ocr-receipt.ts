import { Job } from 'bullmq';
import { updateOcrResults } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { query } from '@/lib/db';

// Cache tesseract availability check at module level (checked once per worker process)
let _systemTesseractAvailable: boolean | null = null;

function isSystemTesseractAvailable(): boolean {
  if (_systemTesseractAvailable !== null) return _systemTesseractAvailable;
  try {
    const { execSync } = require('child_process');
    execSync('which tesseract', { stdio: 'ignore' });
    _systemTesseractAvailable = true;
  } catch {
    _systemTesseractAvailable = false;
  }
  return _systemTesseractAvailable;
}

async function extractTextFromImage(buffer: Buffer): Promise<string> {
  if (isSystemTesseractAvailable()) {
    try {
      // node-tesseract-ocr expects a file path, not a buffer — write to temp file
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const tmpPath = path.join(os.tmpdir(), `receipt-ocr-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, buffer);
      try {
        const { recognize } = await import('node-tesseract-ocr');
        const text = await recognize(tmpPath, { lang: 'eng' });
        return text.trim();
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
      }
    } catch {
      // Fall through to WASM fallback
    }
  }

  const Tesseract = await import('tesseract.js');
  const result = await Tesseract.recognize(buffer, 'eng');
  return result.data.text.trim();
}

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

  const directText = textParts.join('\n').trim();

  // If PDF has no text layer (scanned document), fall back to OCR via WASM tesseract
  // Note: We OCR the raw buffer, not the placeholder thumbnail
  if (!directText) {
    try {
      // Use tesseract.js directly on the PDF buffer — it can handle PDFs
      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.recognize(buffer, 'eng');
      return result.data.text.trim();
    } catch {
      return '';
    }
  }

  return directText;
}

export async function handleOcrReceipt(job: Job): Promise<void> {
  const { receiptId } = job.data as { receiptId: number; bookGuid?: string };
  console.log(`[Job ${job.id}] Starting OCR for receipt ${receiptId}`);

  try {
    await updateOcrResults(receiptId, null, 'processing');

    // Look up receipt by ID directly — don't trust bookGuid from job payload
    const result = await query(
      'SELECT * FROM gnucash_web_receipts WHERE id = $1',
      [receiptId]
    );
    const receipt = result.rows[0];
    if (!receipt) {
      console.warn(`[Job ${job.id}] Receipt ${receiptId} not found, skipping OCR`);
      return;
    }

    const storage = await getStorageBackend();
    const buffer = await storage.get(receipt.storage_key);

    let text: string;
    if (receipt.mime_type === 'application/pdf') {
      text = await extractTextFromPdf(buffer);
    } else {
      text = await extractTextFromImage(buffer);
    }

    const extractedText = text || null;
    await updateOcrResults(receiptId, extractedText, 'complete');
    console.log(`[Job ${job.id}] OCR complete for receipt ${receiptId}: ${extractedText?.length ?? 0} chars extracted`);

    // Run structured extraction on the OCR text
    try {
      const { getAiConfig } = await import('@/lib/ai-config');
      const { extractReceiptData } = await import('@/lib/receipt-extraction');
      const { updateExtractedData } = await import('@/lib/receipts');

      const aiConfig = await getAiConfig(receipt.created_by);
      const extractedData = await extractReceiptData(extractedText || '', aiConfig);
      await updateExtractedData(receiptId, extractedData as unknown as Record<string, unknown>);
      console.log(`[Job ${job.id}] Extraction complete: ${JSON.stringify({ amount: extractedData.amount, vendor: extractedData.vendor, method: extractedData.extraction_method })}`);
    } catch (extractErr) {
      console.error(`[Job ${job.id}] Extraction failed (OCR succeeded):`, extractErr);
    }
  } catch (err) {
    console.error(`[Job ${job.id}] OCR failed for receipt ${receiptId}:`, err);
    await updateOcrResults(receiptId, null, 'failed');
    throw err;
  }
}
