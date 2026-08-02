import { Job } from 'bullmq';
import { execSync } from 'child_process';
import { updateOcrResults } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { query } from '@/lib/db';
import { createHash } from 'node:crypto';
import { linkDocument, upsertDocument } from '@/lib/documents';

interface ReceiptDocumentRow {
  id: number;
  book_guid: string;
  transaction_guid: string | null;
  filename: string;
  storage_key: string;
  mime_type: string;
  file_size: number;
  created_by: number | null;
}

async function syncReceiptDocument(
  receipt: ReceiptDocumentRow,
  buffer: Buffer,
  text: string | null,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  const canonical = await upsertDocument({
    bookGuid: receipt.book_guid,
    ownerUserId: receipt.created_by,
    title: receipt.filename,
    storageKey: receipt.storage_key,
    filename: receipt.filename,
    mimeType: receipt.mime_type,
    sizeBytes: receipt.file_size,
    contentHash: createHash('sha256').update(buffer).digest('hex'),
    extractionStatus: 'completed',
    extractedText: text,
    extractionMetadata: metadata,
    extractedAt: new Date(),
    sourceKind: 'receipt',
    sourceId: String(receipt.id),
  });
  if (receipt.transaction_guid) {
    await linkDocument({
      bookGuid: receipt.book_guid,
      documentId: canonical.id,
      targetType: 'transaction',
      targetId: receipt.transaction_guid,
      role: 'receipt',
      metadata: { autoSource: 'gnucash_web_receipts.transaction_guid' },
    });
  }
}

// Cache tesseract availability check at module level (checked once per worker process)
let _systemTesseractAvailable: boolean | null = null;

function isSystemTesseractAvailable(): boolean {
  if (_systemTesseractAvailable !== null) return _systemTesseractAvailable;
  try {
    execSync('which tesseract', { stdio: 'ignore' });
    _systemTesseractAvailable = true;
  } catch {
    _systemTesseractAvailable = false;
  }
  return _systemTesseractAvailable;
}

export async function extractTextFromImage(buffer: Buffer): Promise<string> {
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
    const receipt = result.rows[0] as ReceiptDocumentRow | undefined;
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
    let structuredData: Record<string, unknown> | null = null;
    if (receipt.created_by != null) try {
      const { getAiConfig } = await import('@/lib/ai-config');
      const { extractReceiptData } = await import('@/lib/receipt-extraction');
      const { updateExtractedData } = await import('@/lib/receipts');

      const aiConfig = await getAiConfig(receipt.created_by);
      const extractedData = await extractReceiptData(extractedText || '', aiConfig);
      await updateExtractedData(receiptId, extractedData as unknown as Record<string, unknown>);
      structuredData = extractedData as unknown as Record<string, unknown>;
      console.log(`[Job ${job.id}] Extraction complete: ${JSON.stringify({ amount: extractedData.amount, vendor: extractedData.vendor, method: extractedData.extraction_method })}`);
    } catch (extractErr) {
      console.error(`[Job ${job.id}] Extraction failed (OCR succeeded):`, extractErr);
      structuredData = {
        structuredExtractionError: extractErr instanceof Error ? extractErr.message : String(extractErr),
      };
    } else {
      structuredData = { structuredExtractionSkipped: 'missing_owner' };
    }

    try {
      await syncReceiptDocument(receipt, buffer, extractedText, structuredData);
    } catch (canonicalError) {
      const detail = canonicalError instanceof Error
        ? canonicalError.message.slice(0, 500)
        : String(canonicalError).slice(0, 500);
      console.warn(
        `[Job ${job.id}] Canonical receipt sync deferred for receipt ${receiptId}: ${detail}`,
      );
    }

    // Bill capture via email: if this receipt arrived through the "bill"
    // ingest route, match the extracted vendor and draft the vendor bill (or
    // park it for review). No-op for ordinary receipts; never throws.
    try {
      const { processPendingEmailBill } = await import('@/lib/business/bill-capture');
      await processPendingEmailBill(receiptId);
    } catch (billErr) {
      console.error(`[Job ${job.id}] Email-bill processing failed for receipt ${receiptId}:`, billErr);
    }
  } catch (err) {
    console.error(`[Job ${job.id}] OCR failed for receipt ${receiptId}:`, err);
    await updateOcrResults(receiptId, null, 'failed');
    throw err;
  }
}
