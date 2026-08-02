/**
 * Entity document vault — expiry math and upload validation.
 *
 *   - daysUntilExpiry: UTC whole-day diff, negative when expired, null
 *     without a date.
 *   - createEntityDocument: title/type/size/mime validation and the orphan
 *     -file cleanup when the DB insert fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { docsModel, storageMock } = vi.hoisted(() => ({
    docsModel: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
    storageMock: {
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        getUrl: vi.fn(),
    },
}));

vi.mock('@/lib/prisma', () => ({
    default: { gnucash_web_entity_documents: docsModel },
}));

vi.mock('@/lib/storage/storage-backend', () => ({
    getStorageBackend: vi.fn(async () => storageMock),
    generateStorageKey: vi.fn(() => '2026/07/uuid.pdf'),
}));

vi.mock('@/lib/services/document-intake', () => ({
    RECEIPT_MAX_FILE_SIZE: 10 * 1024 * 1024,
    sanitizeFilename: (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200),
    detectReceiptMimeType: (buffer: Buffer) =>
        buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46
            ? 'application/pdf'
            : null,
}));

const canonicalMocks = vi.hoisted(() => ({
    getBySource: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    enqueue: vi.fn(),
}));

vi.mock('@/lib/documents', () => ({
    getDocumentBySource: canonicalMocks.getBySource,
    upsertDocument: canonicalMocks.upsert,
    deleteDocumentBySource: canonicalMocks.remove,
}));

vi.mock('@/lib/queue/queues', () => ({ enqueueJob: canonicalMocks.enqueue }));

import {
    DOC_TYPES,
    daysUntilExpiry,
    isValidDocType,
    createEntityDocument,
    updateEntityDocument,
    deleteEntityDocument,
    EntityDocumentValidationError,
} from '../entity-documents.service';

const BOOK = 'b'.repeat(32);
const PDF = Buffer.from('%PDF-1.4 fake');

beforeEach(() => {
    vi.clearAllMocks();
    canonicalMocks.getBySource.mockResolvedValue(null);
    canonicalMocks.upsert.mockResolvedValue({ id: 88 });
    canonicalMocks.remove.mockResolvedValue(true);
    canonicalMocks.enqueue.mockResolvedValue('job-1');
});

describe('daysUntilExpiry', () => {
    const today = new Date('2026-07-14T15:30:00Z');

    it('computes whole days UTC-midnight to UTC-midnight', () => {
        expect(daysUntilExpiry('2026-07-14', today)).toBe(0);
        expect(daysUntilExpiry('2026-07-15', today)).toBe(1);
        expect(daysUntilExpiry('2026-09-12', today)).toBe(60);
    });

    it('is negative once expired and null without a date', () => {
        expect(daysUntilExpiry('2026-07-13', today)).toBe(-1);
        expect(daysUntilExpiry('2025-07-14', today)).toBe(-365);
        expect(daysUntilExpiry(null, today)).toBeNull();
    });
});

describe('isValidDocType', () => {
    it('accepts every first-class document type and rejects the rest', () => {
        expect(DOC_TYPES).toEqual(expect.arrayContaining([
            'formation',
            'ein',
            'election',
            'insurance',
            'license',
            'agreement',
            'farm_certificate_qf',
            'farm_certificate_cf',
            'identity',
            'tax',
            'property',
            'estate',
            'governance',
            'determination',
            'other',
        ]));
        for (const t of DOC_TYPES) {
            expect(isValidDocType(t)).toBe(true);
        }
        expect(isValidDocType('receipt')).toBe(false);
        expect(isValidDocType('')).toBe(false);
        expect(isValidDocType(null)).toBe(false);
    });
});

describe('createEntityDocument', () => {
    const baseInput = {
        title: 'EIN letter',
        docType: 'ein',
        file: { buffer: PDF, filename: 'ein.pdf' },
    };

    it('rejects missing titles, bad types, oversized and non-PDF/image files', async () => {
        await expect(
            createEntityDocument(BOOK, { ...baseInput, title: '  ' })
        ).rejects.toThrow(EntityDocumentValidationError);

        await expect(
            createEntityDocument(BOOK, { ...baseInput, docType: 'passport' })
        ).rejects.toThrow(EntityDocumentValidationError);

        await expect(
            createEntityDocument(BOOK, {
                ...baseInput,
                file: { buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), filename: 'big.pdf' },
            })
        ).rejects.toThrow(/exceeds/);

        await expect(
            createEntityDocument(BOOK, {
                ...baseInput,
                file: { buffer: Buffer.from('plain text'), filename: 'notes.txt' },
            })
        ).rejects.toThrow(/Unsupported file type/);

        expect(storageMock.put).not.toHaveBeenCalled();
    });

    it('stores the file under the entity-documents prefix and creates the row', async () => {
        docsModel.create.mockResolvedValue({
            id: 7,
            book_guid: BOOK,
            title: 'EIN letter',
            doc_type: 'ein',
            file_key: 'entity-documents/2026/07/uuid.pdf',
            file_name: 'ein.pdf',
            mime_type: 'application/pdf',
            size_bytes: BigInt(PDF.byteLength),
            expires_on: null,
            notes: null,
            uploaded_at: new Date('2026-07-14T00:00:00Z'),
        });

        const doc = await createEntityDocument(BOOK, { ...baseInput, ownerUserId: 23 });

        expect(storageMock.put).toHaveBeenCalledWith(
            'entity-documents/2026/07/uuid.pdf',
            PDF,
            'application/pdf',
        );
        expect(doc.id).toBe(7);
        expect(doc.canonicalDocumentId).toBe(88);
        expect(doc.sizeBytes).toBe(PDF.byteLength);
        expect(doc.daysUntilExpiry).toBeNull();
        expect(canonicalMocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
            bookGuid: BOOK,
            ownerUserId: 23,
            sourceKind: 'entity_document',
            sourceId: '7',
        }));
        expect(canonicalMocks.enqueue).toHaveBeenCalledWith('extract-entity-document', {
            documentId: 7,
            bookGuid: BOOK,
            ownerUserId: 23,
        });
    });

    it('cleans up the stored file when the DB insert fails', async () => {
        docsModel.create.mockRejectedValue(new Error('db down'));

        await expect(createEntityDocument(BOOK, baseInput)).rejects.toThrow('db down');
        expect(storageMock.delete).toHaveBeenCalledWith('entity-documents/2026/07/uuid.pdf');
    });
});

describe('deleteEntityDocument', () => {
    it('removes the source row before canonical metadata and the blob', async () => {
        const order: string[] = [];
        docsModel.findUnique.mockResolvedValue({
            id: 12, book_guid: BOOK, title: 'Policy', doc_type: 'insurance',
            file_key: 'entity-documents/policy.pdf', file_name: 'policy.pdf', mime_type: 'application/pdf',
            size_bytes: 100n, expires_on: null, issued_on: null,
            return_copy_due_on: null, notes: null, uploaded_at: new Date(),
        });
        canonicalMocks.remove.mockImplementation(async () => { order.push('canonical'); return true; });
        docsModel.delete.mockImplementation(async () => { order.push('source'); return { id: 12 }; });
        storageMock.delete.mockImplementation(async () => { order.push('blob'); });

        await deleteEntityDocument(BOOK, 12);

        expect(docsModel.delete).toHaveBeenCalledWith({ where: { id: 12 } });
        expect(canonicalMocks.remove).toHaveBeenCalledWith(BOOK, 'entity_document', '12');
        expect(order).toEqual(['source', 'canonical', 'blob']);
    });

    it('leaves canonical metadata and the blob intact when source deletion fails', async () => {
        docsModel.findUnique.mockResolvedValue({
            id: 12, book_guid: BOOK, title: 'Policy', doc_type: 'insurance',
            file_key: 'entity-documents/policy.pdf', file_name: 'policy.pdf', mime_type: 'application/pdf',
            size_bytes: 100n, expires_on: null, issued_on: null,
            return_copy_due_on: null, notes: null, uploaded_at: new Date(),
        });
        docsModel.delete.mockRejectedValue(new Error('source unavailable'));

        await expect(deleteEntityDocument(BOOK, 12)).rejects.toThrow('source unavailable');
        expect(canonicalMocks.remove).not.toHaveBeenCalled();
        expect(storageMock.delete).not.toHaveBeenCalled();
    });

    it('keeps a successful source deletion successful when canonical cleanup fails', async () => {
        docsModel.findUnique.mockResolvedValue({
            id: 12, book_guid: BOOK, title: 'Policy', doc_type: 'insurance',
            file_key: 'entity-documents/policy.pdf', file_name: 'policy.pdf', mime_type: 'application/pdf',
            size_bytes: 100n, expires_on: null, issued_on: null,
            return_copy_due_on: null, notes: null, uploaded_at: new Date(),
        });
        docsModel.delete.mockResolvedValue({ id: 12 });
        canonicalMocks.remove.mockRejectedValue(new Error('canonical unavailable'));

        await expect(deleteEntityDocument(BOOK, 12)).resolves.toBeUndefined();
        expect(storageMock.delete).toHaveBeenCalledWith('entity-documents/policy.pdf');
    });
});

describe('updateEntityDocument', () => {
    it('allows an unchanged legacy type while editing other metadata', async () => {
        const row = {
            id: 11,
            book_guid: BOOK,
            title: 'Imported record',
            doc_type: 'legacy_import',
            file_key: 'entity-documents/legacy.pdf',
            file_name: 'legacy.pdf',
            mime_type: 'application/pdf',
            size_bytes: BigInt(PDF.byteLength),
            expires_on: null,
            issued_on: null,
            return_copy_due_on: null,
            notes: null,
            uploaded_at: new Date('2026-07-14T00:00:00Z'),
        };
        docsModel.findUnique.mockResolvedValue(row);
        docsModel.update.mockResolvedValue({ ...row, title: 'Updated imported record' });

        await expect(
            updateEntityDocument(BOOK, 11, {
                title: 'Updated imported record',
                docType: 'legacy_import',
            })
        ).resolves.toMatchObject({
            title: 'Updated imported record',
            docType: 'legacy_import',
        });
    });

    it('preserves completed OCR and AI suggestions while updating source metadata', async () => {
        const row = {
            id: 11,
            book_guid: BOOK,
            title: 'Policy',
            doc_type: 'insurance',
            file_key: 'entity-documents/policy.pdf',
            file_name: 'policy.pdf',
            mime_type: 'application/pdf',
            size_bytes: BigInt(PDF.byteLength),
            expires_on: new Date('2026-12-31T00:00:00Z'),
            issued_on: new Date('2026-01-01T00:00:00Z'),
            return_copy_due_on: null,
            notes: 'Old note',
            uploaded_at: new Date('2026-07-14T00:00:00Z'),
        };
        const extractedAt = new Date('2026-07-15T00:00:00Z');
        docsModel.findUnique.mockResolvedValue(row);
        docsModel.update.mockResolvedValue({
            ...row,
            expires_on: new Date('2027-12-31T00:00:00Z'),
            notes: 'Renewed policy',
        });
        canonicalMocks.getBySource.mockResolvedValue({
            id: 88,
            ownerUserId: 23,
            contentHash: 'hash',
            dedupeKey: 'content:hash',
            extractionStatus: 'completed',
            extractedText: 'OCR policy text',
            extractionMetadata: {
                extraction: 'ocr',
                suggestionKind: 'insurance_policy',
                suggestions: { carrier: 'Acme' },
            },
            extractionError: null,
            extractedAt,
        });

        await updateEntityDocument(BOOK, 11, {
            expiresOn: '2027-12-31',
            notes: 'Renewed policy',
        });

        expect(canonicalMocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
            extractionStatus: 'completed',
            extractedText: 'OCR policy text',
            extractionMetadata: {
                docType: 'insurance',
                expiresOn: '2027-12-31',
                issuedOn: '2026-01-01',
                returnCopyDueOn: null,
                notes: 'Renewed policy',
            },
            extractionError: null,
            extractedAt,
            preserveExtractionOnConflict: true,
        }));
    });
});
