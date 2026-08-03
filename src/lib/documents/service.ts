import prisma from '@/lib/prisma';
import { query as dbQuery } from '@/lib/db';
import {
  CANONICAL_DOCUMENT_SCHEMA_SQL,
  LEGACY_DOCUMENT_BACKFILL_SQL,
} from './schema';

export const DOCUMENT_SOURCE_KINDS = [
  'upload',
  'receipt',
  'statement_batch',
  'payslip',
  'entity_document',
  'home_item_photo',
  'email_attachment',
  'import',
  'generated',
  'other',
] as const;

export const DOCUMENT_TARGET_TYPES = [
  'account',
  'transaction',
  'receipt',
  'statement_batch',
  'payslip',
  'entity_document',
  'home_item',
  'home_item_photo',
  'renewal',
  'estate_document',
  'vendor_1099',
  'rental_unit',
  'membership_meeting',
  'giving_donation',
  'compliance_item',
  'other',
] as const;

export const DOCUMENT_LINK_ROLES = [
  'attachment',
  'evidence',
  'primary',
  'receipt',
  'purchase_receipt',
  'statement',
  'payslip',
  'photo',
  'supporting_document',
  'w9',
  'form_1099_nec',
  'filing_proof',
  'correspondence',
  'lease',
  'lease_addendum',
  'move_in_inspection',
  'tenant_notice',
  'rent_statement',
  'agenda',
  'minutes',
  'resolution',
  'packet',
  'recording_transcript',
  'acknowledgment',
  'appraisal',
  'form_8283',
  'noncash_receipt',
  'qcd_confirmation',
  'donation_receipt',
  'compliance_evidence',
  'filed_return',
  'payment_confirmation',
  'government_notice',
  'certificate',
  'supporting_workpaper',
  'warranty',
  'manual',
  'serial_photo',
  'claim_evidence',
  'backup',
  'other',
] as const;

export const DOCUMENT_EXTRACTION_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped',
  'not_applicable',
] as const;

export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];
export type DocumentTargetType = (typeof DOCUMENT_TARGET_TYPES)[number];
export type DocumentLinkRole = (typeof DOCUMENT_LINK_ROLES)[number];
export type DocumentExtractionStatus = (typeof DOCUMENT_EXTRACTION_STATUSES)[number];
export type DocumentJson = Record<string, unknown>;

export interface CanonicalDocument {
  id: number;
  bookGuid: string;
  ownerUserId: number | null;
  title: string | null;
  storageKey: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: bigint | null;
  contentHash: string | null;
  dedupeKey: string | null;
  extractionStatus: string;
  extractedText: string | null;
  extractionMetadata: DocumentJson | null;
  extractionError: string | null;
  extractedAt: Date | null;
  sourceKind: string;
  sourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentLink {
  id: number;
  bookGuid: string;
  documentId: number;
  targetType: string;
  targetId: string;
  role: string;
  metadata: DocumentJson;
  createdBy: number | null;
  createdAt: Date;
}

export interface RegisterDocumentInput {
  bookGuid: string;
  ownerUserId?: number | null;
  title?: string | null;
  storageKey?: string | null;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | bigint | null;
  contentHash?: string | null;
  dedupeKey?: string | null;
  extractionStatus?: DocumentExtractionStatus;
  extractedText?: string | null;
  extractionMetadata?: DocumentJson | null;
  extractionError?: string | null;
  extractedAt?: Date | null;
  sourceKind: DocumentSourceKind;
  sourceId?: string | null;
}

export interface UpsertDocumentInput extends RegisterDocumentInput {
  sourceId: string;
  /**
   * Keep extraction-owned fields on conflict and merge the supplied metadata
   * into the current JSON atomically. Inserts still use the supplied seed.
   */
  preserveExtractionOnConflict?: boolean;
}

export interface UpdateDocumentExtractionInput {
  status: DocumentExtractionStatus;
  text?: string | null;
  metadata?: DocumentJson | null;
  error?: string | null;
  extractedAt?: Date | null;
}

export interface LinkDocumentInput {
  bookGuid: string;
  documentId: number;
  targetType: DocumentTargetType;
  targetId: string;
  role?: DocumentLinkRole;
  metadata?: DocumentJson;
  createdBy?: number | null;
}

export interface UnlinkDocumentInput {
  bookGuid: string;
  documentId: number;
  targetType: DocumentTargetType;
  targetId: string;
  role?: DocumentLinkRole;
}

export interface ListDocumentLinksOptions {
  bookGuid: string;
  documentId?: number;
  targetType?: DocumentTargetType;
  targetId?: string;
}

export interface ListDocumentsOptions {
  bookGuid: string;
  sourceKinds?: readonly DocumentSourceKind[];
  extractionStatuses?: readonly DocumentExtractionStatus[];
  query?: string;
  contentHash?: string;
  dedupeKey?: string;
  limit?: number;
  offset?: number;
}

export interface LinkedDocument {
  document: CanonicalDocument;
  link: DocumentLink;
}

export interface DocumentPage {
  documents: CanonicalDocument[];
  hasMore: boolean;
  /** Offset for the next page, or null when the current page is the last. */
  nextOffset: number | null;
}

interface DocumentRow {
  id: number;
  book_guid: string;
  owner_user_id: number | null;
  title: string | null;
  storage_key: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: bigint | number | string | null;
  content_hash: string | null;
  dedupe_key: string | null;
  extraction_status: string;
  extracted_text: string | null;
  extraction_metadata: DocumentJson | null;
  extraction_error: string | null;
  extracted_at: Date | null;
  source_kind: string;
  source_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LinkRow {
  id: number;
  book_guid: string;
  document_id: number;
  target_type: string;
  target_id: string;
  role: string;
  metadata: DocumentJson | null;
  created_by: number | null;
  created_at: Date;
}

const DOCUMENT_COLUMNS = `
  id, book_guid, owner_user_id, title, storage_key, filename, mime_type,
  size_bytes, content_hash, dedupe_key, extraction_status, extracted_text,
  extraction_metadata, extraction_error, extracted_at, source_kind, source_id,
  created_at, updated_at
`;

const LINK_COLUMNS = `
  id, book_guid, document_id, target_type, target_id, role, metadata,
  created_by, created_at
`;

const sourceKindSet = new Set<string>(DOCUMENT_SOURCE_KINDS);
const targetTypeSet = new Set<string>(DOCUMENT_TARGET_TYPES);
const linkRoleSet = new Set<string>(DOCUMENT_LINK_ROLES);
const extractionStatusSet = new Set<string>(DOCUMENT_EXTRACTION_STATUSES);

let schemaPromise: Promise<void> | null = null;
let platformPromise: Promise<void> | null = null;

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(message = 'Document not found in this book') {
    super(message);
    this.name = 'DocumentNotFoundError';
  }
}

function nonEmpty(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new DocumentValidationError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new DocumentValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new DocumentValidationError(`value must be at most ${maxLength} characters`);
  }
  return normalized;
}

function jsonParam(value: DocumentJson | null | undefined): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    throw new DocumentValidationError('metadata must be JSON serializable');
  }
}

function normalizeHash(value: string | null | undefined): string | null {
  const normalized = optionalText(value, 128)?.toLowerCase() ?? null;
  if (normalized && !/^[a-z0-9:+._-]+$/.test(normalized)) {
    throw new DocumentValidationError('contentHash contains unsupported characters');
  }
  return normalized;
}

function mapDocument(row: DocumentRow): CanonicalDocument {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    ownerUserId: row.owner_user_id,
    title: row.title,
    storageKey: row.storage_key,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes == null ? null : BigInt(row.size_bytes),
    contentHash: row.content_hash,
    dedupeKey: row.dedupe_key,
    extractionStatus: row.extraction_status,
    extractedText: row.extracted_text,
    extractionMetadata: row.extraction_metadata,
    extractionError: row.extraction_error,
    extractedAt: row.extracted_at,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLink(row: LinkRow): DocumentLink {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    documentId: row.document_id,
    targetType: row.target_type,
    targetId: row.target_id,
    role: row.role,
    metadata: row.metadata ?? {},
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function validateRegistration(input: RegisterDocumentInput): void {
  nonEmpty(input.bookGuid, 'bookGuid', 32);
  nonEmpty(input.filename, 'filename', 255);
  if (!sourceKindSet.has(input.sourceKind)) {
    throw new DocumentValidationError('Unsupported sourceKind');
  }
  if (input.sourceId != null) nonEmpty(input.sourceId, 'sourceId', 255);
  if (input.sizeBytes != null && BigInt(input.sizeBytes) < 0n) {
    throw new DocumentValidationError('sizeBytes cannot be negative');
  }
  if (input.extractionStatus && !extractionStatusSet.has(input.extractionStatus)) {
    throw new DocumentValidationError('Unsupported extractionStatus');
  }
}

/** Lazily install the idempotent canonical document schema. */
export function ensureCanonicalDocumentTables(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = prisma.$executeRawUnsafe(CANONICAL_DOCUMENT_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaPromise = null;
        throw error;
      });
  }
  return schemaPromise;
}

/** Re-index all recognised legacy document sources without modifying them. */
export async function backfillLegacyDocuments(): Promise<void> {
  await ensureCanonicalDocumentTables();
  await dbQuery(LEGACY_DOCUMENT_BACKFILL_SQL);
}

/** One-process lazy bootstrap used by search and other read paths. */
export function ensureCanonicalDocumentPlatform(): Promise<void> {
  if (!platformPromise) {
    platformPromise = backfillLegacyDocuments().catch((error: unknown) => {
      platformPromise = null;
      throw error;
    });
  }
  return platformPromise;
}

export async function registerDocument(input: RegisterDocumentInput): Promise<CanonicalDocument> {
  validateRegistration(input);
  await ensureCanonicalDocumentTables();

  const hash = normalizeHash(input.contentHash);
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    INSERT INTO gnucash_web_documents (
      book_guid, owner_user_id, title, storage_key, filename, mime_type,
      size_bytes, content_hash, dedupe_key, extraction_status, extracted_text,
      extraction_metadata, extraction_error, extracted_at, source_kind, source_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12::jsonb, $13, $14, $15, $16
    )
    RETURNING ${DOCUMENT_COLUMNS}
  `,
    input.bookGuid.trim(),
    input.ownerUserId ?? null,
    optionalText(input.title, 255),
    optionalText(input.storageKey, 500),
    nonEmpty(input.filename, 'filename', 255),
    optionalText(input.mimeType, 100),
    input.sizeBytes == null ? null : BigInt(input.sizeBytes),
    hash,
    optionalText(input.dedupeKey, 255) ?? (hash ? `content:${hash}` : null),
    input.extractionStatus ?? 'pending',
    input.extractedText ?? null,
    jsonParam(input.extractionMetadata),
    input.extractionError ?? null,
    input.extractedAt ?? null,
    input.sourceKind,
    input.sourceId?.trim() || null,
  );

  if (!rows[0]) throw new Error('Document registration returned no row');
  return mapDocument(rows[0]);
}

export async function upsertDocument(input: UpsertDocumentInput): Promise<CanonicalDocument> {
  validateRegistration(input);
  const sourceId = nonEmpty(input.sourceId, 'sourceId', 255);
  await ensureCanonicalDocumentTables();

  const hash = normalizeHash(input.contentHash);
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    INSERT INTO gnucash_web_documents (
      book_guid, owner_user_id, title, storage_key, filename, mime_type,
      size_bytes, content_hash, dedupe_key, extraction_status, extracted_text,
      extraction_metadata, extraction_error, extracted_at, source_kind, source_id
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      $12::jsonb, $13, $14, $15, $16
    )
    ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
      owner_user_id = EXCLUDED.owner_user_id,
      title = EXCLUDED.title,
      storage_key = EXCLUDED.storage_key,
      filename = EXCLUDED.filename,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      content_hash = EXCLUDED.content_hash,
      dedupe_key = EXCLUDED.dedupe_key,
      extraction_status = CASE WHEN $17::boolean
        THEN gnucash_web_documents.extraction_status ELSE EXCLUDED.extraction_status END,
      extracted_text = CASE WHEN $17::boolean
        THEN gnucash_web_documents.extracted_text ELSE EXCLUDED.extracted_text END,
      extraction_metadata = CASE WHEN $17::boolean
        THEN COALESCE(gnucash_web_documents.extraction_metadata, '{}'::jsonb)
          || COALESCE(EXCLUDED.extraction_metadata, '{}'::jsonb)
        ELSE EXCLUDED.extraction_metadata END,
      extraction_error = CASE WHEN $17::boolean
        THEN gnucash_web_documents.extraction_error ELSE EXCLUDED.extraction_error END,
      extracted_at = CASE WHEN $17::boolean
        THEN gnucash_web_documents.extracted_at ELSE EXCLUDED.extracted_at END,
      updated_at = CURRENT_TIMESTAMP
    RETURNING ${DOCUMENT_COLUMNS}
  `,
    input.bookGuid.trim(),
    input.ownerUserId ?? null,
    optionalText(input.title, 255),
    optionalText(input.storageKey, 500),
    nonEmpty(input.filename, 'filename', 255),
    optionalText(input.mimeType, 100),
    input.sizeBytes == null ? null : BigInt(input.sizeBytes),
    hash,
    optionalText(input.dedupeKey, 255) ?? (hash ? `content:${hash}` : null),
    input.extractionStatus ?? 'pending',
    input.extractedText ?? null,
    jsonParam(input.extractionMetadata),
    input.extractionError ?? null,
    input.extractedAt ?? null,
    input.sourceKind,
    sourceId,
    input.preserveExtractionOnConflict ?? false,
  );

  if (!rows[0]) throw new Error('Document upsert returned no row');
  return mapDocument(rows[0]);
}

/** Fail-closed lookup used before every link or metadata mutation. */
export async function validateDocumentBookScope(
  bookGuid: string,
  documentId: number,
): Promise<CanonicalDocument> {
  nonEmpty(bookGuid, 'bookGuid', 32);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    throw new DocumentValidationError('documentId must be a positive integer');
  }
  await ensureCanonicalDocumentTables();
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    SELECT ${DOCUMENT_COLUMNS}
    FROM gnucash_web_documents
    WHERE id = $1 AND book_guid = $2
    LIMIT 1
  `, documentId, bookGuid.trim());
  if (!rows[0]) throw new DocumentNotFoundError();
  return mapDocument(rows[0]);
}

/** Book-scoped canonical-id lookup for generic document consumers. */
export const getDocument = validateDocumentBookScope;

/**
 * Fail-closed batch of {@link validateDocumentBookScope}: one query for many
 * ids. Ids outside the book are simply absent from the map, so every caller
 * still has to decide what a missing id means for its own surface.
 */
export async function getDocumentsByIds(
  bookGuid: string,
  documentIds: readonly number[],
): Promise<Map<number, CanonicalDocument>> {
  nonEmpty(bookGuid, 'bookGuid', 32);
  for (const documentId of documentIds) {
    if (!Number.isInteger(documentId) || documentId <= 0) {
      throw new DocumentValidationError('documentId must be a positive integer');
    }
  }
  const unique = [...new Set(documentIds)];
  if (unique.length === 0) return new Map();
  await ensureCanonicalDocumentTables();
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    SELECT ${DOCUMENT_COLUMNS}
    FROM gnucash_web_documents
    WHERE id = ANY($1::int[]) AND book_guid = $2
  `, unique, bookGuid.trim());
  return new Map(rows.map((row) => [row.id, mapDocument(row)]));
}

/** Resolve a specialised source id (for example entity_document/42). */
export async function getDocumentBySource(
  bookGuid: string,
  sourceKind: DocumentSourceKind,
  sourceId: string,
): Promise<CanonicalDocument | null> {
  nonEmpty(bookGuid, 'bookGuid', 32);
  if (!sourceKindSet.has(sourceKind)) {
    throw new DocumentValidationError('Unsupported sourceKind');
  }
  await ensureCanonicalDocumentTables();
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    SELECT ${DOCUMENT_COLUMNS}
    FROM gnucash_web_documents
    WHERE book_guid = $1 AND source_kind = $2 AND source_id = $3
    LIMIT 1
  `, bookGuid.trim(), sourceKind, nonEmpty(sourceId, 'sourceId', 255));
  return rows[0] ? mapDocument(rows[0]) : null;
}

/**
 * Batch of {@link getDocumentBySource} for one source kind. Unresolved source
 * ids are absent from the map, matching the single-row `null` contract.
 */
export async function getDocumentsBySources(
  bookGuid: string,
  sourceKind: DocumentSourceKind,
  sourceIds: readonly string[],
): Promise<Map<string, CanonicalDocument>> {
  nonEmpty(bookGuid, 'bookGuid', 32);
  if (!sourceKindSet.has(sourceKind)) {
    throw new DocumentValidationError('Unsupported sourceKind');
  }
  const unique = [...new Set(sourceIds.map((id) => nonEmpty(id, 'sourceId', 255)))];
  if (unique.length === 0) return new Map();
  await ensureCanonicalDocumentTables();
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    SELECT ${DOCUMENT_COLUMNS}
    FROM gnucash_web_documents
    WHERE book_guid = $1 AND source_kind = $2 AND source_id = ANY($3::text[])
  `, bookGuid.trim(), sourceKind, unique);
  const resolved = new Map<string, CanonicalDocument>();
  for (const row of rows) {
    if (row.source_id != null && !resolved.has(row.source_id)) {
      resolved.set(row.source_id, mapDocument(row));
    }
  }
  return resolved;
}

/**
 * Remove only the canonical index row for a deleted specialised source.
 * The source lifecycle remains authoritative and is never mutated here.
 */
export async function deleteDocumentBySource(
  bookGuid: string,
  sourceKind: DocumentSourceKind,
  sourceId: string,
): Promise<boolean> {
  nonEmpty(bookGuid, 'bookGuid', 32);
  if (!sourceKindSet.has(sourceKind)) {
    throw new DocumentValidationError('Unsupported sourceKind');
  }
  await ensureCanonicalDocumentTables();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(`
    DELETE FROM gnucash_web_documents
    WHERE book_guid = $1 AND source_kind = $2 AND source_id = $3
    RETURNING id
  `, bookGuid.trim(), sourceKind, nonEmpty(sourceId, 'sourceId', 255));
  return rows.length > 0;
}

export async function updateDocumentExtraction(
  bookGuid: string,
  documentId: number,
  patch: UpdateDocumentExtractionInput,
): Promise<CanonicalDocument> {
  if (!extractionStatusSet.has(patch.status)) {
    throw new DocumentValidationError('Unsupported extraction status');
  }
  await validateDocumentBookScope(bookGuid, documentId);
  const rows = await prisma.$queryRawUnsafe<DocumentRow[]>(`
    UPDATE gnucash_web_documents
    SET extraction_status = $3,
        extracted_text = $4,
        extraction_metadata = $5::jsonb,
        extraction_error = $6,
        extracted_at = $7,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1 AND book_guid = $2
    RETURNING ${DOCUMENT_COLUMNS}
  `,
    documentId,
    bookGuid.trim(),
    patch.status,
    patch.text ?? null,
    jsonParam(patch.metadata),
    patch.error ?? null,
    patch.extractedAt === undefined
      ? (patch.status === 'completed' ? new Date() : null)
      : patch.extractedAt,
  );
  if (!rows[0]) throw new DocumentNotFoundError();
  return mapDocument(rows[0]);
}

export async function linkDocument(input: LinkDocumentInput): Promise<DocumentLink> {
  if (!targetTypeSet.has(input.targetType)) {
    throw new DocumentValidationError('Unsupported targetType');
  }
  const role = input.role ?? 'attachment';
  if (!linkRoleSet.has(role)) throw new DocumentValidationError('Unsupported link role');
  const targetId = nonEmpty(input.targetId, 'targetId', 255);
  await validateDocumentBookScope(input.bookGuid, input.documentId);

  const rows = await prisma.$queryRawUnsafe<LinkRow[]>(`
    INSERT INTO gnucash_web_document_links (
      book_guid, document_id, target_type, target_id, role, metadata, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT (document_id, target_type, target_id, role) DO UPDATE SET
      metadata = EXCLUDED.metadata,
      created_by = COALESCE(gnucash_web_document_links.created_by, EXCLUDED.created_by)
    RETURNING ${LINK_COLUMNS}
  `,
    input.bookGuid.trim(),
    input.documentId,
    input.targetType,
    targetId,
    role,
    jsonParam(input.metadata ?? {}),
    input.createdBy ?? null,
  );
  if (!rows[0]) throw new Error('Document link returned no row');
  return mapLink(rows[0]);
}

export async function unlinkDocument(input: UnlinkDocumentInput): Promise<boolean> {
  const role = input.role ?? 'attachment';
  if (!targetTypeSet.has(input.targetType)) {
    throw new DocumentValidationError('Unsupported targetType');
  }
  if (!linkRoleSet.has(role)) throw new DocumentValidationError('Unsupported link role');
  await validateDocumentBookScope(input.bookGuid, input.documentId);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(`
    DELETE FROM gnucash_web_document_links
    WHERE book_guid = $1 AND document_id = $2
      AND target_type = $3 AND target_id = $4 AND role = $5
    RETURNING id
  `,
    input.bookGuid.trim(),
    input.documentId,
    input.targetType,
    nonEmpty(input.targetId, 'targetId', 255),
    role,
  );
  return rows.length > 0;
}

export async function listDocumentLinks(options: ListDocumentLinksOptions): Promise<DocumentLink[]> {
  nonEmpty(options.bookGuid, 'bookGuid', 32);
  if (options.documentId == null && !options.targetType) {
    throw new DocumentValidationError('documentId or targetType is required');
  }
  if (options.documentId != null) {
    await validateDocumentBookScope(options.bookGuid, options.documentId);
  } else {
    await ensureCanonicalDocumentTables();
  }
  if (options.targetType && !targetTypeSet.has(options.targetType)) {
    throw new DocumentValidationError('Unsupported targetType');
  }

  const conditions = ['book_guid = $1'];
  const params: unknown[] = [options.bookGuid.trim()];
  if (options.documentId != null) {
    params.push(options.documentId);
    conditions.push(`document_id = $${params.length}`);
  }
  if (options.targetType) {
    params.push(options.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (options.targetId) {
    params.push(nonEmpty(options.targetId, 'targetId', 255));
    conditions.push(`target_id = $${params.length}`);
  }

  const rows = await prisma.$queryRawUnsafe<LinkRow[]>(`
    SELECT ${LINK_COLUMNS}
    FROM gnucash_web_document_links
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
  `, ...params);
  return rows.map(mapLink);
}

/**
 * Resolve link rows and their canonical documents for generic picker/detail UIs.
 *
 * The document read is a single batched query regardless of link count. A link
 * whose document is missing or owned by another book still fails the whole call
 * with {@link DocumentNotFoundError}, exactly as the per-link scope check did.
 */
export async function listLinkedDocuments(
  options: ListDocumentLinksOptions,
): Promise<LinkedDocument[]> {
  const links = await listDocumentLinks(options);
  if (links.length === 0) return [];
  const documents = await getDocumentsByIds(
    options.bookGuid,
    links.map((link) => link.documentId),
  );
  return links.map((link) => {
    const document = documents.get(link.documentId);
    if (!document) throw new DocumentNotFoundError();
    return { link, document };
  });
}

function buildDocumentFilter(
  options: ListDocumentsOptions,
): { conditions: string[]; params: unknown[] } {
  const conditions = ['book_guid = $1'];
  const params: unknown[] = [options.bookGuid.trim()];
  if (options.sourceKinds?.length) {
    for (const kind of options.sourceKinds) {
      if (!sourceKindSet.has(kind)) throw new DocumentValidationError('Unsupported sourceKind');
    }
    params.push([...options.sourceKinds]);
    conditions.push(`source_kind = ANY($${params.length}::text[])`);
  }
  if (options.extractionStatuses?.length) {
    for (const status of options.extractionStatuses) {
      if (!extractionStatusSet.has(status)) {
        throw new DocumentValidationError('Unsupported extraction status');
      }
    }
    params.push([...options.extractionStatuses]);
    conditions.push(`extraction_status = ANY($${params.length}::text[])`);
  }
  if (options.contentHash) {
    params.push(normalizeHash(options.contentHash));
    conditions.push(`content_hash = $${params.length}`);
  }
  if (options.dedupeKey) {
    params.push(nonEmpty(options.dedupeKey, 'dedupeKey', 255));
    conditions.push(`dedupe_key = $${params.length}`);
  }
  if (options.query?.trim()) {
    const search = nonEmpty(options.query, 'query', 200);
    params.push(search);
    const queryIndex = params.length;
    params.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    const likeIndex = params.length;
    conditions.push(`(
      search_tsvector @@ websearch_to_tsquery('english', $${queryIndex})
      OR title ILIKE $${likeIndex}
      OR filename ILIKE $${likeIndex}
      OR extracted_text ILIKE $${likeIndex}
    )`);
  }

  return { conditions, params };
}

function pageBounds(options: ListDocumentsOptions): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100),
    offset: Math.max(Math.floor(options.offset ?? 0), 0),
  };
}

async function selectDocuments(
  options: ListDocumentsOptions,
  fetchLimit: number,
  offset: number,
): Promise<DocumentRow[]> {
  nonEmpty(options.bookGuid, 'bookGuid', 32);
  await ensureCanonicalDocumentTables();
  const { conditions, params } = buildDocumentFilter(options);
  params.push(fetchLimit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;
  return prisma.$queryRawUnsafe<DocumentRow[]>(`
    SELECT ${DOCUMENT_COLUMNS}
    FROM gnucash_web_documents
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex}
  `, ...params);
}

export async function listDocuments(options: ListDocumentsOptions): Promise<CanonicalDocument[]> {
  const { limit, offset } = pageBounds(options);
  const rows = await selectDocuments(options, limit, offset);
  return rows.map(mapDocument);
}

/**
 * Paged {@link listDocuments} for search-backed pickers. One extra row is read
 * to report `hasMore` without a second COUNT query.
 */
export async function listDocumentsPage(options: ListDocumentsOptions): Promise<DocumentPage> {
  const { limit, offset } = pageBounds(options);
  const rows = await selectDocuments(options, limit + 1, offset);
  const hasMore = rows.length > limit;
  return {
    documents: rows.slice(0, limit).map(mapDocument),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}
