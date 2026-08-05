import { Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { updateOcrResults } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import { query } from '@/lib/db';
import { createHash } from 'node:crypto';
import { linkDocument, upsertDocument } from '@/lib/documents';
import { extractPdfText } from '@/lib/pdf-text-extract';

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

const execFileAsync = promisify(execFile);

async function extractWithSystemTesseract(buffer: Buffer): Promise<string> {
  // mkdtemp gives every concurrent worker job a private, unpredictable path.
  // execFile bypasses a shell entirely, so neither the path nor options can be
  // interpreted as commands (unlike the retired node-tesseract-ocr package).
  const workDir = await mkdtemp(join(tmpdir(), 'gnucash-web-ocr-'));
  const inputPath = join(workDir, 'input.png');
  try {
    await writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync(
      'tesseract',
      [inputPath, 'stdout', '-l', 'eng'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function extractTextFromImage(buffer: Buffer): Promise<string> {
  try {
    return await extractWithSystemTesseract(buffer);
  } catch {
    // Binary unavailable or failed: fall through to the WASM implementation.
  }

  const Tesseract = await import('tesseract.js');
  const result = await Tesseract.recognize(buffer, 'eng');
  return result.data.text.trim();
}

/**
 * OCR the raw bytes of a scanned PDF with WASM tesseract. Kept separate from
 * `extractTextFromImage`: the system tesseract binary cannot read PDF input, so
 * scanned PDFs always take the WASM path. We OCR the buffer, not a thumbnail.
 */
export async function extractTextFromPdfViaOcr(buffer: Buffer): Promise<string> {
  const Tesseract = await import('tesseract.js');
  const result = await Tesseract.recognize(buffer, 'eng');
  return result.data.text.trim();
}

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const { text } = await extractPdfText(buffer, { ocr: extractTextFromPdfViaOcr });
  return text;
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
