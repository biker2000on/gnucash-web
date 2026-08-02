import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';

const {
  requireRole,
  getResilienceProfile,
  storageGet,
  listLinkedDocuments,
  getDocumentBySource,
  getEntityDocumentFile,
  findItems,
  findReceipt,
} = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getResilienceProfile: vi.fn(),
  storageGet: vi.fn(),
  listLinkedDocuments: vi.fn(),
  getDocumentBySource: vi.fn(),
  getEntityDocumentFile: vi.fn(),
  findItems: vi.fn(),
  findReceipt: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ requireRole }));
vi.mock('@/lib/resilience/service', () => ({ getResilienceProfile }));
vi.mock('@/lib/storage/storage-backend', () => ({
  getStorageBackend: vi.fn(async () => ({ get: storageGet })),
}));
vi.mock('@/lib/documents', () => ({ listLinkedDocuments, getDocumentBySource }));
vi.mock('@/lib/services/entity-documents.service', () => ({ getEntityDocumentFile }));
vi.mock('@/lib/prisma', () => ({
  default: {
    gnucash_web_home_items: { findMany: findItems },
    gnucash_web_receipts: { findFirst: findReceipt },
  },
}));

import { GET, storedFileExtension } from './route';

const BOOK = 'book-a';
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const pdf = new TextEncoder().encode('%PDF-1.4 test');

function document(id: number, storageKey: string, sourceKind = 'upload', sourceId: string | null = null) {
  return {
    id,
    title: `Document ${id}`,
    filename: `document-${id}.pdf`,
    mimeType: 'application/pdf',
    storageKey,
    sourceKind,
    sourceId,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };
}

describe('home claims package canonical documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRole.mockResolvedValue({ bookGuid: BOOK, user: { id: 1 }, role: 'readonly' });
    getResilienceProfile.mockResolvedValue({
      policies: [{
        id: 'policy-1',
        type: 'home',
        provider: 'Acme',
        policyNumber: '12345678',
        coveredEntity: 'Home',
        coverageLimit: 100000,
        deductible: 1000,
        annualPremium: 1200,
        renewalDate: '2027-01-01',
        sublimits: [],
        documentIds: [9],
      }],
    });
    findItems.mockResolvedValue([{
      id: 7,
      name: 'Heat pump',
      category: 'HVAC',
      est_value: 9000,
      serial: 'SERIAL',
      purchase_date: new Date('2025-01-01T00:00:00Z'),
      receipt_id: 4,
      notes: null,
      room: { name: 'Basement' },
      photos: [{ id: 3, photo_key: 'photo-key' }],
    }]);
    findReceipt.mockResolvedValue({
      id: 4,
      book_guid: BOOK,
      storage_key: 'receipt-key',
      mime_type: 'application/pdf',
      filename: 'receipt.pdf',
    });
    listLinkedDocuments.mockImplementation(async ({ targetType }: { targetType: string }) => {
      if (targetType === 'home_item') return [
        { document: document(31, 'photo-key', 'home_item_photo', '3'), link: { targetId: '7', role: 'photo' } },
        { document: document(32, 'warranty-key'), link: { targetId: '7', role: 'warranty' } },
        { document: document(33, 'receipt-key', 'receipt', '4'), link: { targetId: '7', role: 'purchase_receipt' } },
      ];
      if (targetType === 'entity_document') return [];
      return [];
    });
    getDocumentBySource.mockResolvedValue(document(40, 'policy-key', 'entity_document', '9'));
    storageGet.mockImplementation(async (key: string) => {
      if (key === 'photo-key') return Buffer.from(png);
      return Buffer.from(pdf);
    });
  });

  it('uses file signatures, includes canonical links, dedupes storage keys, and stays book-scoped', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const paths = Object.keys(zip);

    expect(paths).toContain('photos/item-7-1.png');
    expect(paths.some(path => path.includes('home-item-7/document-32-document-32.pdf'))).toBe(true);
    expect(paths.some(path => path.includes('policy-documents/document-40-document-40.pdf'))).toBe(true);
    expect(paths.filter(path => path.includes('document-31-'))).toHaveLength(0);
    expect(paths.filter(path => path.includes('document-33-'))).toHaveLength(0);
    expect(storageGet.mock.calls.filter(call => call[0] === 'photo-key')).toHaveLength(1);
    expect(storageGet.mock.calls.filter(call => call[0] === 'receipt-key')).toHaveLength(1);
    expect(listLinkedDocuments).toHaveBeenCalledWith({ bookGuid: BOOK, targetType: 'home_item' });
    expect(listLinkedDocuments).toHaveBeenCalledWith({ bookGuid: BOOK, targetType: 'entity_document' });
    expect(getDocumentBySource).toHaveBeenCalledWith(BOOK, 'entity_document', '9');
    expect(findReceipt).toHaveBeenCalledWith({ where: { id: 4, book_guid: BOOK } });
    expect(getEntityDocumentFile).not.toHaveBeenCalled();
  });

  it('does not label a PNG as JPEG even when metadata says image/jpeg', () => {
    expect(storedFileExtension(png, 'image/jpeg', 'camera.jpg')).toBe('png');
  });

  it('falls back to the legacy policy vault with the authorized book scope', async () => {
    getDocumentBySource.mockResolvedValue(null);
    getEntityDocumentFile.mockResolvedValue({
      buffer: Buffer.from(pdf),
      fileName: 'legacy-policy.pdf',
      mimeType: 'application/pdf',
    });

    const response = await GET();
    const paths = Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())));
    expect(paths.some(path => path.includes('policy-documents/document-9-legacy-policy.pdf'))).toBe(true);
    expect(getEntityDocumentFile).toHaveBeenCalledWith(BOOK, 9);
  });
});
