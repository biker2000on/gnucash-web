/**
 * Entity document vault — formation docs, EIN letters, elections, insurance
 * certificates, licenses, and agreements for a book's business entity.
 *
 * Files reuse the receipts storage pipeline (`getStorageBackend`) under an
 * `entity-documents/` key prefix, with the same 10MB / JPEG-PNG-PDF limits
 * enforced from magic bytes. Every read/write is fetched-then-checked
 * against the caller's active book_guid.
 */

import prisma from '@/lib/prisma';
import {
    getStorageBackend,
    generateStorageKey,
} from '@/lib/storage/storage-backend';
import {
    RECEIPT_MAX_FILE_SIZE,
    detectReceiptMimeType,
    sanitizeFilename,
} from '@/lib/services/document-intake';

/* ------------------------------------------------------------------ */
/* Constants + pure helpers                                             */
/* ------------------------------------------------------------------ */

export const DOCUMENT_MAX_FILE_SIZE = RECEIPT_MAX_FILE_SIZE; // 10MB, same as receipts
export const DOCUMENT_KEY_PREFIX = 'entity-documents/';

export const DOC_TYPES = [
    'formation',
    'ein',
    'election',
    'insurance',
    'license',
    'agreement',
    'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function isValidDocType(value: unknown): value is DocType {
    return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value);
}

/** Docs expiring within this many days count as "expiring soon". */
export const EXPIRY_WARNING_DAYS = 60;

const DAY_MS = 86_400_000;

/**
 * Whole days until expiry (UTC-midnight to UTC-midnight). Negative when
 * already expired; null when the document has no expiry date.
 */
export function daysUntilExpiry(
    expiresOn: Date | string | null,
    today: Date = new Date(),
): number | null {
    if (!expiresOn) return null;
    const exp = new Date(expiresOn);
    if (isNaN(exp.getTime())) return null;
    const expDay = Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate());
    const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((expDay - todayDay) / DAY_MS);
}

export class EntityDocumentValidationError extends Error {}
export class EntityDocumentNotFoundError extends Error {}

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface EntityDocument {
    id: number;
    title: string;
    docType: string;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    /** ISO date (YYYY-MM-DD) or null. */
    expiresOn: string | null;
    notes: string | null;
    uploadedAt: string;
    /** Negative = expired, null = no expiry set. */
    daysUntilExpiry: number | null;
}

interface DocDbRow {
    id: number;
    book_guid: string;
    title: string;
    doc_type: string;
    file_key: string | null;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: bigint | null;
    expires_on: Date | null;
    notes: string | null;
    uploaded_at: Date;
}

function mapDocument(row: DocDbRow, today: Date = new Date()): EntityDocument {
    return {
        id: row.id,
        title: row.title,
        docType: row.doc_type,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        expiresOn: row.expires_on ? row.expires_on.toISOString().slice(0, 10) : null,
        notes: row.notes,
        uploadedAt: row.uploaded_at.toISOString(),
        daysUntilExpiry: daysUntilExpiry(row.expires_on, today),
    };
}

function parseExpiresOn(value: string | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new EntityDocumentValidationError('expiresOn must be YYYY-MM-DD');
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (isNaN(date.getTime())) {
        throw new EntityDocumentValidationError('Invalid expiresOn date');
    }
    return date;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

/** All documents for the book, expiring-first then newest upload first. */
export async function listEntityDocuments(bookGuid: string): Promise<EntityDocument[]> {
    const rows = await prisma.gnucash_web_entity_documents.findMany({
        where: { book_guid: bookGuid },
        orderBy: [{ uploaded_at: 'desc' }],
    });
    const today = new Date();
    return rows
        .map((r) => mapDocument(r, today))
        .sort((a, b) => {
            const ax = a.daysUntilExpiry ?? Number.POSITIVE_INFINITY;
            const bx = b.daysUntilExpiry ?? Number.POSITIVE_INFINITY;
            return ax - bx || a.title.localeCompare(b.title);
        });
}

export interface CreateEntityDocumentInput {
    title: string;
    docType: string;
    expiresOn?: string | null;
    notes?: string | null;
    file: { buffer: Buffer; filename: string };
}

/** Validate + store the file, then create the metadata row (file cleaned up on DB failure). */
export async function createEntityDocument(
    bookGuid: string,
    input: CreateEntityDocumentInput,
): Promise<EntityDocument> {
    const title = input.title?.trim();
    if (!title) throw new EntityDocumentValidationError('Title is required');
    if (title.length > 255) throw new EntityDocumentValidationError('Title too long (max 255)');
    if (!isValidDocType(input.docType)) {
        throw new EntityDocumentValidationError(
            `Invalid document type (expected one of: ${DOC_TYPES.join(', ')})`
        );
    }
    const expiresOn = parseExpiresOn(input.expiresOn);

    const { buffer, filename } = input.file;
    if (buffer.byteLength === 0) {
        throw new EntityDocumentValidationError('Empty file');
    }
    if (buffer.byteLength > DOCUMENT_MAX_FILE_SIZE) {
        throw new EntityDocumentValidationError(
            `File exceeds ${DOCUMENT_MAX_FILE_SIZE / 1024 / 1024}MB limit`
        );
    }
    const mimeType = detectReceiptMimeType(buffer);
    if (!mimeType) {
        throw new EntityDocumentValidationError('Unsupported file type (must be JPEG, PNG, or PDF)');
    }

    const sanitizedName = sanitizeFilename(filename);
    const fileKey = DOCUMENT_KEY_PREFIX + generateStorageKey(sanitizedName);
    const storage = await getStorageBackend();
    await storage.put(fileKey, buffer, mimeType);

    try {
        const row = await prisma.gnucash_web_entity_documents.create({
            data: {
                book_guid: bookGuid,
                title,
                doc_type: input.docType,
                file_key: fileKey,
                file_name: sanitizedName,
                mime_type: mimeType,
                size_bytes: BigInt(buffer.byteLength),
                expires_on: expiresOn,
                notes: input.notes?.trim() || null,
            },
        });
        return mapDocument(row);
    } catch (error) {
        // Don't strand an orphan file when the DB insert fails.
        try {
            await storage.delete(fileKey);
        } catch (cleanupErr) {
            console.warn('Failed to clean up orphan document file:', cleanupErr);
        }
        throw error;
    }
}

async function getOwnedDocument(bookGuid: string, id: number): Promise<DocDbRow> {
    const row = await prisma.gnucash_web_entity_documents.findUnique({ where: { id } });
    if (!row || row.book_guid !== bookGuid) {
        throw new EntityDocumentNotFoundError('Document not found');
    }
    return row;
}

export interface UpdateEntityDocumentInput {
    title?: string;
    docType?: string;
    expiresOn?: string | null;
    notes?: string | null;
}

export async function updateEntityDocument(
    bookGuid: string,
    id: number,
    input: UpdateEntityDocumentInput,
): Promise<EntityDocument> {
    await getOwnedDocument(bookGuid, id);

    const data: {
        title?: string;
        doc_type?: string;
        expires_on?: Date | null;
        notes?: string | null;
    } = {};

    if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new EntityDocumentValidationError('Title is required');
        if (title.length > 255) throw new EntityDocumentValidationError('Title too long (max 255)');
        data.title = title;
    }
    if (input.docType !== undefined) {
        if (!isValidDocType(input.docType)) {
            throw new EntityDocumentValidationError(
                `Invalid document type (expected one of: ${DOC_TYPES.join(', ')})`
            );
        }
        data.doc_type = input.docType;
    }
    if (input.expiresOn !== undefined) {
        data.expires_on = parseExpiresOn(input.expiresOn);
    }
    if (input.notes !== undefined) {
        data.notes = input.notes?.trim() || null;
    }

    const row = await prisma.gnucash_web_entity_documents.update({ where: { id }, data });
    return mapDocument(row);
}

/** Delete the metadata row AND the stored file (file failure is non-fatal). */
export async function deleteEntityDocument(bookGuid: string, id: number): Promise<void> {
    const row = await getOwnedDocument(bookGuid, id);

    if (row.file_key) {
        try {
            const storage = await getStorageBackend();
            await storage.delete(row.file_key);
        } catch (err) {
            console.warn('Failed to delete document file:', err);
        }
    }

    await prisma.gnucash_web_entity_documents.delete({ where: { id } });
}

export interface EntityDocumentFile {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
}

/** Fetch the stored file for a book-owned document (receipts serve pattern). */
export async function getEntityDocumentFile(
    bookGuid: string,
    id: number,
): Promise<EntityDocumentFile> {
    const row = await getOwnedDocument(bookGuid, id);
    if (!row.file_key) {
        throw new EntityDocumentNotFoundError('Document has no stored file');
    }
    const storage = await getStorageBackend();
    const buffer = await storage.get(row.file_key);
    return {
        buffer,
        fileName: row.file_name ?? 'document',
        mimeType: row.mime_type ?? 'application/octet-stream',
    };
}
