import { Job } from 'bullmq';
import { updateOcrResults, getReceiptById } from '@/lib/receipts';
import { getStorageBackend } from '@/lib/storage/storage-backend';

async function extractTextFromImage(buffer: Buffer): Promise<string> {
  try {
    const { execSync } = await import('child_process');
    execSync('which tesseract', { stdio: 'ignore' });
    const { recognize } = await import('node-tesseract-ocr');
    const text = await recognize(buffer, { lang: 'eng' });
    return text.trim();
  } catch {
    const Tesseract = await import('tesseract.js');
    const result = await Tesseract.recognize(buffer, 'eng');
    return result.data.text.trim();
  }
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
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

  if (!directText) {
    try {
      const { generateThumbnail } = await import('@/lib/storage/thumbnail');
      const imageBuffer = await generateThumbnail(buffer, 'application/pdf');
      return extractTextFromImage(imageBuffer);
    } catch {
      return '';
    }
  }

  return directText;
}

export async function handleOcrReceipt(job: Job): Promise<void> {
  const { receiptId, bookGuid } = job.data as { receiptId: number; bookGuid: string };
  console.log(`[Job ${job.id}] Starting OCR for receipt ${receiptId}`);

  try {
    await updateOcrResults(receiptId, null, 'processing');

    const receipt = await getReceiptById(receiptId, bookGuid);
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

    await updateOcrResults(receiptId, text || null, 'complete');
    console.log(`[Job ${job.id}] OCR complete for receipt ${receiptId}: ${text.length} chars extracted`);
  } catch (err) {
    console.error(`[Job ${job.id}] OCR failed for receipt ${receiptId}:`, err);
    await updateOcrResults(receiptId, null, 'failed');
    throw err;
  }
}
