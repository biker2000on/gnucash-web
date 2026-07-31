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

import {
    DOC_TYPES,
    daysUntilExpiry,
    isValidDocType,
    createEntityDocument,
    updateEntityDocument,
    EntityDocumentValidationError,
} from '../entity-documents.service';

const BOOK = 'b'.repeat(32);
const PDF = Buffer.from('%PDF-1.4 fake');

beforeEach(() => {
    vi.clearAllMocks();
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

        const doc = await createEntityDocument(BOOK, baseInput);

        expect(storageMock.put).toHaveBeenCalledWith(
            'entity-documents/2026/07/uuid.pdf',
            PDF,
            'application/pdf',
        );
        expect(doc.id).toBe(7);
        expect(doc.sizeBytes).toBe(PDF.byteLength);
        expect(doc.daysUntilExpiry).toBeNull();
    });

    it('cleans up the stored file when the DB insert fails', async () => {
        docsModel.create.mockRejectedValue(new Error('db down'));

        await expect(createEntityDocument(BOOK, baseInput)).rejects.toThrow('db down');
        expect(storageMock.delete).toHaveBeenCalledWith('entity-documents/2026/07/uuid.pdf');
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
});
