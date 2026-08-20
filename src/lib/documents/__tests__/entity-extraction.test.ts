import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getBySource: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  storageGet: vi.fn(),
  pdfText: vi.fn(),
  ocrPdf: vi.fn(),
  ocrImage: vi.fn(),
  getAiConfig: vi.fn(),
  chat: vi.fn(),
  insurance: vi.fn(),
  estate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: { gnucash_web_entity_documents: { findFirst: mocks.findFirst } },
}));
vi.mock('../service', () => ({
  getDocumentBySource: mocks.getBySource,
  upsertDocument: mocks.upsert,
  updateDocumentExtraction: mocks.update,
}));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({ get: mocks.storageGet })),
}));
vi.mock('@/lib/pdf-text-extract', () => ({ extractPdfText: mocks.pdfText }));
vi.mock('@/lib/queue/jobs/ocr-receipt', () => ({
  extractTextFromPdfViaOcr: mocks.ocrPdf,
  extractTextFromImage: mocks.ocrImage,
}));
vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.getAiConfig }));
vi.mock('@/lib/ai-query/client', () => ({ chatComplete: mocks.chat }));
vi.mock('@/lib/resilience/insurance-parse', () => ({
  extractInsurancePolicyDocument: mocks.insurance,
}));
vi.mock('@/lib/resilience/estate-parse', () => ({ extractEstateDocument: mocks.estate }));
vi.mock('@/lib/queue/jobs/render-document-thumbnail', () => ({
  enqueueDocumentThumbnail: vi.fn(async () => undefined),
}));
vi.mock('../document-tags', () => ({
  applyDocumentTagRulesForDocument: vi.fn(async () => 0),
}));

import {
  buildTaxRecordSuggestionPrompt,
  parseGenericDocumentSuggestions,
  parseTaxRecordSuggestions,
  runEntityDocumentExtraction,
} from '../entity-extraction';

const BOOK = 'b'.repeat(32);
const canonical = {
  id: 80,
  bookGuid: BOOK,
  ownerUserId: 23,
  extractionMetadata: { docType: 'license' },
  extractedText: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({
    id: 7,
    book_guid: BOOK,
    title: 'Operating license',
    doc_type: 'license',
    file_key: 'vault/license.pdf',
    file_name: 'license.pdf',
    mime_type: 'application/pdf',
    size_bytes: 100n,
    notes: null,
  });
  mocks.getBySource.mockResolvedValue(canonical);
  mocks.storageGet.mockResolvedValue(Buffer.from('%PDF'));
  mocks.pdfText.mockResolvedValue({
    text: 'License issued to Acme LLC on 2026-01-10 ref LIC-22',
    source: 'text-layer',
    ocrError: null,
  });
  mocks.ocrPdf.mockResolvedValue('Scanned license for Acme LLC');
  mocks.getAiConfig.mockResolvedValue({
    enabled: true, base_url: 'https://ai.invalid', model: 'test', api_key: null,
  });
  mocks.chat.mockResolvedValue(JSON.stringify({
    document_class: 'business license',
    effective_dates: ['2026-01-10', 'not-a-date'],
    parties: ['Acme LLC'],
    reference_numbers: ['LIC-22'],
  }));
  mocks.update.mockResolvedValue(canonical);
});

describe('parseGenericDocumentSuggestions', () => {
  it('normalizes advisory tags and drops invalid names', () => {
    const parsed = parseGenericDocumentSuggestions(JSON.stringify({
      document_class: 'policy',
      tags: ['Farm', '!!!', 'tax-year'],
    }));
    expect(parsed.tags).toEqual(['farm', 'tax-year']);
  });

  it('bounds arrays and rejects malformed dates', () => {
    const parsed = parseGenericDocumentSuggestions(JSON.stringify({
      document_class: 'license',
      effective_dates: ['2026-01-10', 'soon'],
      parties: Array.from({ length: 30 }, (_, index) => `Party ${index}`),
      reference_numbers: ['A-1'],
    }));
    expect(parsed.effectiveDates).toEqual(['2026-01-10']);
    expect(parsed.parties).toHaveLength(20);
    expect(parsed.tags).toEqual([]);
  });
});

describe('parseTaxRecordSuggestions', () => {
  it('keeps valid form/year/issuer and strips code fences', () => {
    const parsed = parseTaxRecordSuggestions(
      '```json\n{"tax_form":"1099_int","tax_year":2024,"issuer":"Ally Bank"}\n```'
    );
    expect(parsed).toEqual({ taxForm: '1099_int', taxYear: 2024, issuer: 'Ally Bank' });
  });

  it('drops values outside the vocabulary or year range instead of guessing', () => {
    const parsed = parseTaxRecordSuggestions(JSON.stringify({
      tax_form: 'form-8843',
      tax_year: 1492,
      issuer: '   ',
    }));
    expect(parsed).toEqual({ taxForm: null, taxYear: null, issuer: null });
  });

  it('accepts a stringified year', () => {
    expect(parseTaxRecordSuggestions(JSON.stringify({ tax_year: '2023' })).taxYear).toBe(2023);
  });

  it('prompt carries the allowed vocabulary and the document text', () => {
    const prompt = buildTaxRecordSuggestionPrompt('Wages, tips 42');
    expect(prompt).toContain('1099_int (1099-INT)');
    expect(prompt).toContain('Wages, tips 42');
  });
});

describe('tax record extraction pass', () => {
  it('runs the tax prompt for tax documents and stores tax_record suggestions', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 7,
      book_guid: BOOK,
      title: 'Ally 1099-INT',
      doc_type: 'tax',
      file_key: 'vault/1099.pdf',
      file_name: '1099.pdf',
      mime_type: 'application/pdf',
      size_bytes: 100n,
      notes: null,
    });
    mocks.chat.mockResolvedValue(JSON.stringify({
      tax_form: '1099_int', tax_year: 2024, issuer: 'Ally Bank',
    }));

    await runEntityDocumentExtraction(7, BOOK);

    expect(mocks.chat).toHaveBeenCalledTimes(1);
    const prompt = mocks.chat.mock.calls[0][1][0].content as string;
    expect(prompt).toContain('tax record');
    const completed = mocks.update.mock.calls.at(-1)![2];
    expect(completed.status).toBe('completed');
    expect(completed.metadata.suggestionKind).toBe('tax_record');
    expect(completed.metadata.suggestions).toEqual({
      taxForm: '1099_int',
      taxYear: 2024,
      issuer: 'Ally Bank',
      suggestedTags: ['1099_int', 'ally-bank', 'tax'],
    });
  });
});

describe('runEntityDocumentExtraction', () => {
  it('uses the uploader AI config and persists bounded suggestions as metadata only', async () => {
    await runEntityDocumentExtraction(7, BOOK);

    expect(mocks.getAiConfig).toHaveBeenCalledWith(23);
    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      status: 'completed',
      text: expect.stringContaining('Acme LLC'),
      metadata: expect.objectContaining({
        suggestionKind: 'generic_document',
        suggestions: expect.objectContaining({
          effectiveDates: ['2026-01-10'],
          referenceNumbers: ['LIC-22'],
        }),
      }),
    }));
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 7, book_guid: BOOK } });
  });

  it('indexes OCR without inventing a user identity when owner is null', async () => {
    mocks.getBySource.mockResolvedValue({ ...canonical, ownerUserId: null });
    await runEntityDocumentExtraction(7, BOOK);
    expect(mocks.getAiConfig).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      status: 'completed',
    }));
  });

  it('reuses the insurance parser for insurance documents', async () => {
    mocks.findFirst.mockResolvedValue({
      ...(await mocks.findFirst()),
      doc_type: 'insurance',
    });
    mocks.insurance.mockResolvedValue({ provider: 'Acme Insurance' });
    await runEntityDocumentExtraction(7, BOOK);
    expect(mocks.insurance).toHaveBeenCalledWith(expect.objectContaining({
      aiConfig: expect.objectContaining({ enabled: true }),
    }));
    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      metadata: expect.objectContaining({ suggestionKind: 'insurance_policy' }),
    }));
  });

  it('indexes a scanned PDF through the injected OCR fallback', async () => {
    mocks.pdfText.mockImplementation(async (buffer, options) => ({
      text: await options.ocr(buffer),
      source: 'ocr',
      ocrError: null,
    }));

    await runEntityDocumentExtraction(7, BOOK);

    expect(mocks.ocrPdf).toHaveBeenCalledWith(expect.any(Buffer));
    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      status: 'completed',
      text: 'Scanned license for Acme LLC',
      metadata: expect.objectContaining({ textSource: 'ocr', characterCount: 28 }),
    }));
  });

  it('fails the document when neither the text layer nor OCR yields text', async () => {
    mocks.pdfText.mockResolvedValue({
      text: '',
      source: 'none',
      ocrError: 'PDF has no text layer and OCR failed: tesseract unavailable',
    });

    await runEntityDocumentExtraction(7, BOOK);

    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      status: 'failed',
      text: null,
      error: 'PDF has no text layer and OCR failed: tesseract unavailable',
      metadata: expect.objectContaining({ textSource: 'none', characterCount: 0 }),
    }));
  });

  it('marks file types without an extractor not_applicable', async () => {
    mocks.findFirst.mockResolvedValue({
      ...(await mocks.findFirst()),
      mime_type: 'application/zip',
    });

    await runEntityDocumentExtraction(7, BOOK);

    expect(mocks.pdfText).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenLastCalledWith(BOOK, 80, expect.objectContaining({
      status: 'not_applicable',
      error: 'No text extractor for application/zip',
    }));
  });
});
