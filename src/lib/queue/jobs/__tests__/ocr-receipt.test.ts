import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  updateOcr: vi.fn(),
  storageGet: vi.fn(),
  getAiConfig: vi.fn(),
  upsert: vi.fn(),
  link: vi.fn(),
  recognize: vi.fn(),
  pdfExtract: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ query: mocks.query }));
vi.mock('@/lib/receipts', () => ({
  updateOcrResults: mocks.updateOcr,
  updateExtractedData: vi.fn(),
}));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({ get: mocks.storageGet })),
}));
vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.getAiConfig }));
vi.mock('@/lib/documents', () => ({
  upsertDocument: mocks.upsert,
  linkDocument: mocks.link,
}));
vi.mock('@/lib/business/bill-capture', () => ({ processPendingEmailBill: vi.fn() }));
vi.mock('tesseract.js', () => ({
  recognize: mocks.recognize,
  default: { recognize: mocks.recognize },
}));
vi.mock('@/lib/pdf-text-extract', () => ({ extractPdfText: mocks.pdfExtract }));

import { handleOcrReceipt } from '../ocr-receipt';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [{
    id: 5,
    book_guid: 'book-1',
    transaction_guid: null,
    filename: 'receipt.jpg',
    storage_key: 'receipts/5.jpg',
    mime_type: 'image/jpeg',
    file_size: 4,
    created_by: null,
  }] });
  mocks.storageGet.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  mocks.recognize.mockResolvedValue({ data: { text: 'Store total 12.34' } });
  mocks.upsert.mockResolvedValue({ id: 90 });
});

describe('handleOcrReceipt canonical sync', () => {
  it('indexes OCR but skips structured AI extraction for a null owner', async () => {
    await handleOcrReceipt({ id: 'job-1', data: { receiptId: 5 } } as never);

    expect(mocks.getAiConfig).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      bookGuid: 'book-1',
      ownerUserId: null,
      extractionStatus: 'completed',
      extractedText: 'Store total 12.34',
      extractionMetadata: { structuredExtractionSkipped: 'missing_owner' },
      sourceKind: 'receipt',
      sourceId: '5',
    }));
  });

  it('keeps completed OCR authoritative when canonical indexing is unavailable', async () => {
    mocks.upsert.mockRejectedValueOnce(new Error('canonical database unavailable'));

    await expect(
      handleOcrReceipt({ id: 'job-1', data: { receiptId: 5 } } as never),
    ).resolves.toBeUndefined();

    expect(mocks.updateOcr).toHaveBeenLastCalledWith(5, 'Store total 12.34', 'complete');
    expect(mocks.updateOcr).not.toHaveBeenCalledWith(5, null, 'failed');
  });
});

describe('scanned PDF receipts', () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 5,
      book_guid: 'book-1',
      transaction_guid: null,
      filename: 'receipt.pdf',
      storage_key: 'receipts/5.pdf',
      mime_type: 'application/pdf',
      file_size: 4,
      created_by: null,
    }] });
  });

  it('still reaches tesseract through the shared PDF extractor', async () => {
    mocks.pdfExtract.mockImplementation(async (buffer, options) => ({
      text: await options.ocr(buffer),
      source: 'ocr',
      ocrError: null,
    }));
    mocks.recognize.mockResolvedValue({ data: { text: '  Scanned receipt 42.00  ' } });

    await handleOcrReceipt({ id: 'job-2', data: { receiptId: 5 } } as never);

    expect(mocks.recognize).toHaveBeenCalledOnce();
    expect(mocks.updateOcr).toHaveBeenLastCalledWith(5, 'Scanned receipt 42.00', 'complete');
  });
});
