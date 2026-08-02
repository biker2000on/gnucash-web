import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getBySource: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  storageGet: vi.fn(),
  pdfText: vi.fn(),
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
vi.mock('@/lib/pdf-text-extract', () => ({ extractTextFromPdf: mocks.pdfText }));
vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.getAiConfig }));
vi.mock('@/lib/ai-query/client', () => ({ chatComplete: mocks.chat }));
vi.mock('@/lib/resilience/insurance-parse', () => ({
  extractInsurancePolicyDocument: mocks.insurance,
}));
vi.mock('@/lib/resilience/estate-parse', () => ({ extractEstateDocument: mocks.estate }));

import {
  parseGenericDocumentSuggestions,
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
  mocks.pdfText.mockResolvedValue('License issued to Acme LLC on 2026-01-10 ref LIC-22');
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
  it('bounds arrays and rejects malformed dates', () => {
    const parsed = parseGenericDocumentSuggestions(JSON.stringify({
      document_class: 'license',
      effective_dates: ['2026-01-10', 'soon'],
      parties: Array.from({ length: 30 }, (_, index) => `Party ${index}`),
      reference_numbers: ['A-1'],
    }));
    expect(parsed.effectiveDates).toEqual(['2026-01-10']);
    expect(parsed.parties).toHaveLength(20);
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
});
