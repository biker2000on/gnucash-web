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
import {
    DOCUMENT_TYPE_VALUES,
    TAX_FORM_VALUES,
    isValidTaxForm,
    isValidTaxYear,
} from '@/lib/entity-document-context';
import { createHash } from 'node:crypto';
import { enqueueJob } from '@/lib/queue/queues';
import {
    deleteDocumentBySource,
    getDocumentBySource,
    upsertDocument,
} from '@/lib/documents';

/* ------------------------------------------------------------------ */
/* Constants + pure helpers                                             */
/* ------------------------------------------------------------------ */

export const DOCUMENT_MAX_FILE_SIZE = RECEIPT_MAX_FILE_SIZE; // 10MB, same as receipts
export const DOCUMENT_KEY_PREFIX = 'entity-documents/';

export const DOC_TYPES = DOCUMENT_TYPE_VALUES;
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
    issuedOn: string | null;
    returnCopyDueOn: string | null;
    notes: string | null;
    /** Tax records archive (doc_type 'tax'). */
    taxYear: number | null;
    taxForm: string | null;
    issuer: string | null;
    uploadedAt: string;
    /** Negative = expired, null = no expiry set. */
    daysUntilExpiry: number | null;
    /** Present on a newly-created row; existing clients can keep using `id`. */
    canonicalDocumentId?: number;
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
    issued_on: Date | null;
    return_copy_due_on: Date | null;
    notes: string | null;
    tax_year: number | null;
    tax_form: string | null;
    issuer: string | null;
    uploaded_at: Date;
}

/**
 * `canonicalDocumentId` is the `gnucash_web_documents.id` that indexes this
 * row. It is a DIFFERENT key space from `id` (the entity-document id) and the
 * two collide freely — search hits are keyed by the canonical id, so a client
 * that has to match a hit back to a vault row needs both. Pass
 * `canonicalIdByDocument` whenever the caller has already batch-loaded the
 * mapping; omitting it simply leaves the field undefined (as before).
 */
function mapDocument(
    row: DocDbRow,
    today: Date = new Date(),
    canonicalIdByDocument?: Map<number, number>,
): EntityDocument {
    const canonicalDocumentId = canonicalIdByDocument?.get(row.id);
    return {
        ...(canonicalDocumentId === undefined ? {} : { canonicalDocumentId }),
        id: row.id,
        title: row.title,
        docType: row.doc_type,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        expiresOn: row.expires_on ? row.expires_on.toISOString().slice(0, 10) : null,
        issuedOn: row.issued_on ? row.issued_on.toISOString().slice(0, 10) : null,
        returnCopyDueOn: row.return_copy_due_on
            ? row.return_copy_due_on.toISOString().slice(0, 10)
            : null,
        notes: row.notes,
        taxYear: row.tax_year,
        taxForm: row.tax_form,
        issuer: row.issuer,
        uploadedAt: row.uploaded_at.toISOString(),
        daysUntilExpiry: daysUntilExpiry(row.expires_on, today),
    };
}

async function syncEntityDocumentIndex(
    row: DocDbRow,
    contentHash?: string,
    ownerUserId?: number | null,
): Promise<number> {
    const existing = await getDocumentBySource(row.book_guid, 'entity_document', String(row.id));
    const canonical = await upsertDocument({
        bookGuid: row.book_guid,
        ownerUserId: ownerUserId ?? existing?.ownerUserId ?? null,
        title: row.title,
        storageKey: row.file_key,
        filename: row.file_name ?? row.title,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        contentHash: contentHash ?? existing?.contentHash ?? null,
        dedupeKey: existing?.dedupeKey ?? null,
        extractionStatus: (existing?.extractionStatus as 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'not_applicable' | undefined) ?? 'pending',
        extractedText: existing?.extractedText ?? row.notes,
        extractionMetadata: {
            docType: row.doc_type,
            expiresOn: row.expires_on?.toISOString().slice(0, 10) ?? null,
            issuedOn: row.issued_on?.toISOString().slice(0, 10) ?? null,
            returnCopyDueOn: row.return_copy_due_on?.toISOString().slice(0, 10) ?? null,
            notes: row.notes,
            taxYear: row.tax_year,
            taxForm: row.tax_form,
            issuer: row.issuer,
        },
        extractionError: existing?.extractionError ?? null,
        extractedAt: existing?.extractedAt ?? null,
        sourceKind: 'entity_document',
        sourceId: String(row.id),
        preserveExtractionOnConflict: true,
    });
    return canonical.id;
}

function parseTaxYear(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (!isValidTaxYear(value)) {
        throw new EntityDocumentValidationError('taxYear must be a year between 1980 and 2100');
    }
    return value;
}

function parseTaxForm(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (!isValidTaxForm(value)) {
        throw new EntityDocumentValidationError(
            `Invalid tax form (expected one of: ${TAX_FORM_VALUES.join(', ')})`
        );
    }
    return value;
}

function parseIssuer(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const issuer = value.trim();
    if (issuer.length > 255) {
        throw new EntityDocumentValidationError('Issuer too long (max 255)');
    }
    return issuer || null;
}

function parseDate(value: string | null | undefined, field: string): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new EntityDocumentValidationError(`${field} must be YYYY-MM-DD`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (isNaN(date.getTime())) {
        throw new EntityDocumentValidationError(`Invalid ${field} date`);
    }
    return date;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

/**
 * entity-document id -> canonical `gnucash_web_documents.id` for the book.
 * One batched read; the canonical table may not exist on an older deployment,
 * in which case the vault simply lists without canonical ids.
 */
async function canonicalIdsForEntityDocuments(bookGuid: string): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
        const rows = await prisma.$queryRaw<Array<{ id: number; source_id: string | null }>>`
            SELECT id, source_id
            FROM gnucash_web_documents
            WHERE book_guid = ${bookGuid}
              AND source_kind = 'entity_document'
        `;
        for (const row of rows) {
            const entityId = Number.parseInt(row.source_id ?? '', 10);
            if (Number.isInteger(entityId) && entityId > 0) map.set(entityId, row.id);
        }
    } catch {
        // Canonical index not provisioned yet — callers treat the id as optional.
    }
    return map;
}

/** All documents for the book, expiring-first then newest upload first. */
export async function listEntityDocuments(bookGuid: string): Promise<EntityDocument[]> {
    const rows = await prisma.gnucash_web_entity_documents.findMany({
        where: { book_guid: bookGuid },
        orderBy: [{ uploaded_at: 'desc' }],
    });
    const today = new Date();
    const canonicalIds = await canonicalIdsForEntityDocuments(bookGuid);
    return rows
        .map((r) => mapDocument(r, today, canonicalIds))
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
    issuedOn?: string | null;
    returnCopyDueOn?: string | null;
    notes?: string | null;
    taxYear?: number | null;
    taxForm?: string | null;
    issuer?: string | null;
    /** Authenticated uploader; used only for ownership and their AI config. */
    ownerUserId?: number | null;
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
    const expiresOn = parseDate(input.expiresOn, 'expiresOn');
    const issuedOn = parseDate(input.issuedOn, 'issuedOn');
    const returnCopyDueOn = parseDate(input.returnCopyDueOn, 'returnCopyDueOn');
    const taxYear = parseTaxYear(input.taxYear);
    const taxForm = parseTaxForm(input.taxForm);
    const issuer = parseIssuer(input.issuer);

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
                issued_on: issuedOn,
                return_copy_due_on: returnCopyDueOn,
                notes: input.notes?.trim() || null,
                tax_year: taxYear,
                tax_form: taxForm,
                issuer,
            },
        });
        const canonicalDocumentId = await syncEntityDocumentIndex(
            row,
            createHash('sha256').update(buffer).digest('hex'),
            input.ownerUserId,
        );

        const jobId = await enqueueJob('extract-entity-document', {
            documentId: row.id,
            bookGuid,
            ownerUserId: input.ownerUserId ?? null,
        });
        if (!jobId) {
            try {
                const { runEntityDocumentExtraction } = await import('@/lib/documents/entity-extraction');
                await runEntityDocumentExtraction(row.id, bookGuid, `[inline-entity-doc-${row.id}]`);
            } catch (extractError) {
                console.error(`Inline entity-document extraction failed for ${row.id}:`, extractError);
            }
        }

        return { ...mapDocument(row), canonicalDocumentId };
    } catch (error) {
        // The specialised row must not survive if canonical registration
        // failed; otherwise callers cannot resolve the just-uploaded file.
        try {
            const created = await prisma.gnucash_web_entity_documents.findFirst({
                where: { book_guid: bookGuid, file_key: fileKey },
                select: { id: true },
            });
            if (created) {
                await prisma.gnucash_web_entity_documents.delete({ where: { id: created.id } });
            }
        } catch (rowCleanupErr) {
            console.warn('Failed to clean up orphan document row:', rowCleanupErr);
        }
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
    issuedOn?: string | null;
    returnCopyDueOn?: string | null;
    notes?: string | null;
    taxYear?: number | null;
    taxForm?: string | null;
    issuer?: string | null;
}

export async function updateEntityDocument(
    bookGuid: string,
    id: number,
    input: UpdateEntityDocumentInput,
): Promise<EntityDocument> {
    const existing = await getOwnedDocument(bookGuid, id);

    const data: {
        title?: string;
        doc_type?: string;
        expires_on?: Date | null;
        issued_on?: Date | null;
        return_copy_due_on?: Date | null;
        notes?: string | null;
        tax_year?: number | null;
        tax_form?: string | null;
        issuer?: string | null;
    } = {};

    if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new EntityDocumentValidationError('Title is required');
        if (title.length > 255) throw new EntityDocumentValidationError('Title too long (max 255)');
        data.title = title;
    }
    if (input.docType !== undefined) {
        // Permit an existing pre-contract type to remain unchanged while the
        // document's other metadata is edited. New and changed types must use
        // the first-class DOC_TYPES contract.
        if (!isValidDocType(input.docType) && input.docType !== existing.doc_type) {
            throw new EntityDocumentValidationError(
                `Invalid document type (expected one of: ${DOC_TYPES.join(', ')})`
            );
        }
        data.doc_type = input.docType;
    }
    if (input.expiresOn !== undefined) {
        data.expires_on = parseDate(input.expiresOn, 'expiresOn');
    }
    if (input.issuedOn !== undefined) {
        data.issued_on = parseDate(input.issuedOn, 'issuedOn');
    }
    if (input.returnCopyDueOn !== undefined) {
        data.return_copy_due_on = parseDate(input.returnCopyDueOn, 'returnCopyDueOn');
    }
    if (input.notes !== undefined) {
        data.notes = input.notes?.trim() || null;
    }
    if (input.taxYear !== undefined) {
        data.tax_year = parseTaxYear(input.taxYear);
    }
    if (input.taxForm !== undefined) {
        data.tax_form = parseTaxForm(input.taxForm);
    }
    if (input.issuer !== undefined) {
        data.issuer = parseIssuer(input.issuer);
    }

    const row = await prisma.gnucash_web_entity_documents.update({ where: { id }, data });
    await syncEntityDocumentIndex(row);
    return mapDocument(row);
}

/** Delete the metadata row AND the stored file (file failure is non-fatal). */
export async function deleteEntityDocument(bookGuid: string, id: number): Promise<void> {
    const row = await getOwnedDocument(bookGuid, id);

    // Delete the authoritative source first. If it fails, canonical metadata,
    // manual links, and the blob remain intact. Sidecar cleanup is best effort;
    // bootstrap prunes any orphan left by a transient canonical failure.
    await prisma.gnucash_web_entity_documents.delete({ where: { id } });
    try {
        await deleteDocumentBySource(bookGuid, 'entity_document', String(id));
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        console.warn(`Failed to clean up canonical entity document: ${message}`);
    }

    if (row.file_key) {
        try {
            const storage = await getStorageBackend();
            await storage.delete(row.file_key);
        } catch (err) {
            console.warn('Failed to delete document file:', err);
        }
    }
}

export interface EntityDocumentSuggestions {
    /** Canonical extraction status: pending | processing | completed | failed | … */
    extractionStatus: string | null;
    suggestionKind: string | null;
    suggestions: unknown;
    suggestionError: string | null;
}

/**
 * AI suggestions produced by the extraction pipeline for a book-owned
 * document (tax_record / insurance_policy / estate_document / generic).
 * Suggestions are advisory — accepting them is an explicit client PUT.
 */
export async function getEntityDocumentSuggestions(
    bookGuid: string,
    id: number,
): Promise<EntityDocumentSuggestions> {
    await getOwnedDocument(bookGuid, id);
    const canonical = await getDocumentBySource(bookGuid, 'entity_document', String(id));
    const metadata = (canonical?.extractionMetadata ?? {}) as Record<string, unknown>;
    return {
        extractionStatus: canonical?.extractionStatus ?? null,
        suggestionKind: typeof metadata.suggestionKind === 'string' ? metadata.suggestionKind : null,
        suggestions: metadata.suggestions ?? null,
        suggestionError: typeof metadata.suggestionError === 'string' ? metadata.suggestionError : null,
    };
}

/** Re-run extraction (and AI suggestions) for an already-uploaded document. */
export async function requeueEntityDocumentExtraction(
    bookGuid: string,
    id: number,
    ownerUserId: number | null,
): Promise<void> {
    await getOwnedDocument(bookGuid, id);
    const jobId = await enqueueJob('extract-entity-document', {
        documentId: id,
        bookGuid,
        ownerUserId,
    });
    if (!jobId) {
        const { runEntityDocumentExtraction } = await import('@/lib/documents/entity-extraction');
        await runEntityDocumentExtraction(id, bookGuid, `[reextract-entity-doc-${id}]`);
    }
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
