import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  raw: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    $executeRawUnsafe: mocks.execute,
    $queryRawUnsafe: mocks.raw,
  },
}));

vi.mock('@/lib/db', () => ({ query: mocks.dbQuery }));

import {
  DocumentNotFoundError,
  DocumentValidationError,
  backfillLegacyDocuments,
  deleteDocumentBySource,
  linkDocument,
  listDocumentLinks,
  registerDocument,
  updateDocumentExtraction,
  upsertDocument,
  validateDocumentBookScope,
} from '../service';
import { LEGACY_DOCUMENT_BACKFILL_SQL } from '../schema';

const BOOK = 'b'.repeat(32);
const NOW = new Date('2026-08-02T12:00:00Z');

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    book_guid: BOOK,
    owner_user_id: 7,
    title: 'Policy',
    storage_key: 'vault/policy.pdf',
    filename: 'policy.pdf',
    mime_type: 'application/pdf',
    size_bytes: '2048',
    content_hash: 'abc123',
    dedupe_key: 'content:abc123',
    extraction_status: 'completed',
    extracted_text: 'policy text',
    extraction_metadata: { characterCount: 11 },
    extraction_error: null,
    extracted_at: NOW,
    source_kind: 'entity_document',
    source_id: '44',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    book_guid: BOOK,
    document_id: 12,
    target_type: 'home_item',
    target_id: '9',
    role: 'warranty',
    metadata: { label: 'Freezer' },
    created_by: 7,
    created_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue(0);
  mocks.dbQuery.mockResolvedValue({ rows: [] });
});

describe('canonical document registration', () => {
  it('registers scoped metadata and maps BIGINT size safely', async () => {
    mocks.raw.mockResolvedValueOnce([documentRow()]);
    const result = await registerDocument({
      bookGuid: BOOK,
      ownerUserId: 7,
      filename: 'policy.pdf',
      storageKey: 'vault/policy.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      contentHash: 'ABC123',
      sourceKind: 'entity_document',
      sourceId: '44',
    });

    expect(result.sizeBytes).toBe(2048n);
    expect(result.bookGuid).toBe(BOOK);
    expect(mocks.raw.mock.calls[0][0]).toContain('INSERT INTO gnucash_web_documents');
    expect(mocks.raw.mock.calls[0]).toContain('abc123');
  });

  it('upserts only on the book/source identity', async () => {
    mocks.raw.mockResolvedValueOnce([documentRow()]);
    await upsertDocument({
      bookGuid: BOOK,
      filename: 'policy.pdf',
      sourceKind: 'entity_document',
      sourceId: '44',
    });
    expect(mocks.raw.mock.calls[0][0]).toContain(
      'ON CONFLICT (book_guid, source_kind, source_id)',
    );
  });

  it('atomically preserves completed extraction state during a source-metadata upsert', async () => {
    mocks.raw.mockResolvedValueOnce([documentRow()]);
    await upsertDocument({
      bookGuid: BOOK,
      filename: 'policy.pdf',
      extractionMetadata: { docType: 'insurance', notes: 'renewed' },
      sourceKind: 'entity_document',
      sourceId: '44',
      preserveExtractionOnConflict: true,
    });

    const sql = String(mocks.raw.mock.calls[0][0]);
    expect(sql).toContain('CASE WHEN $17::boolean');
    expect(sql).toContain('THEN gnucash_web_documents.extraction_status');
    expect(sql).toContain('THEN gnucash_web_documents.extracted_text');
    expect(sql).toContain('THEN gnucash_web_documents.extraction_error');
    expect(sql).toContain('THEN gnucash_web_documents.extracted_at');
    expect(sql).toContain("COALESCE(gnucash_web_documents.extraction_metadata, '{}'::jsonb)");
    expect(sql).toContain("|| COALESCE(EXCLUDED.extraction_metadata, '{}'::jsonb)");
    expect(mocks.raw.mock.calls[0].at(-1)).toBe(true);
  });

  it('rejects invalid metadata before touching the database', async () => {
    await expect(registerDocument({
      bookGuid: BOOK,
      filename: '',
      sourceKind: 'upload',
    })).rejects.toBeInstanceOf(DocumentValidationError);
    expect(mocks.raw).not.toHaveBeenCalled();
  });
});

describe('scope and links', () => {
  it('fails closed when a canonical id is outside the requested book', async () => {
    mocks.raw.mockResolvedValueOnce([]);
    await expect(validateDocumentBookScope(BOOK, 12))
      .rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(mocks.raw.mock.calls[0][0]).toContain('id = $1 AND book_guid = $2');
  });

  it('validates scope and idempotently links a typed target', async () => {
    mocks.raw
      .mockResolvedValueOnce([documentRow()])
      .mockResolvedValueOnce([linkRow()]);
    const result = await linkDocument({
      bookGuid: BOOK,
      documentId: 12,
      targetType: 'home_item',
      targetId: '9',
      role: 'warranty',
      metadata: { label: 'Freezer' },
      createdBy: 7,
    });
    expect(result.role).toBe('warranty');
    expect(mocks.raw.mock.calls[1][0]).toContain(
      'ON CONFLICT (document_id, target_type, target_id, role)',
    );
  });

  it('lists edges by a book-scoped target without exposing another book', async () => {
    mocks.raw.mockResolvedValueOnce([linkRow()]);
    const links = await listDocumentLinks({
      bookGuid: BOOK,
      targetType: 'home_item',
      targetId: '9',
    });
    expect(links).toHaveLength(1);
    expect(mocks.raw.mock.calls[0].slice(1)).toEqual([BOOK, 'home_item', '9']);
  });

  it('supports book-scoped enumeration by target type for reports', async () => {
    mocks.raw.mockResolvedValueOnce([linkRow()]);
    await expect(listDocumentLinks({ bookGuid: BOOK, targetType: 'home_item' }))
      .resolves.toHaveLength(1);
    expect(mocks.raw.mock.calls[0].slice(1)).toEqual([BOOK, 'home_item']);
  });

  it('updates extraction metadata only after scope validation', async () => {
    mocks.raw
      .mockResolvedValueOnce([documentRow()])
      .mockResolvedValueOnce([documentRow({ extraction_status: 'failed' })]);
    const updated = await updateDocumentExtraction(BOOK, 12, {
      status: 'failed',
      error: 'OCR failed',
    });
    expect(updated.extractionStatus).toBe('failed');
    expect(mocks.raw.mock.calls[1][0]).toContain('WHERE id = $1 AND book_guid = $2');
  });
});

describe('legacy lifecycle', () => {
  it('backfills every specialised source and home purchase-receipt edge non-destructively', async () => {
    await backfillLegacyDocuments();
    expect(mocks.dbQuery).toHaveBeenCalledWith(LEGACY_DOCUMENT_BACKFILL_SQL);
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'receipt'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'statement_batch'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'payslip'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'entity_document'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'home_item_photo'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'purchase_receipt'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).not.toMatch(/DELETE FROM gnucash_web_(receipts|payslips|entity_documents|home_item_photos)/);
  });

  it('preserves entity OCR/AI fields while merging current source metadata on rerun', () => {
    const entityStart = LEGACY_DOCUMENT_BACKFILL_SQL.indexOf("'docType', e.doc_type");
    const entityEnd = LEGACY_DOCUMENT_BACKFILL_SQL.indexOf("'home_item_photo', p.id::TEXT");
    const entityConflict = LEGACY_DOCUMENT_BACKFILL_SQL.slice(entityStart, entityEnd);

    expect(entityConflict).toContain("'notes', e.notes");
    expect(entityConflict).toContain(
      "COALESCE(gnucash_web_documents.extraction_metadata, '{}'::jsonb)",
    );
    expect(entityConflict).not.toMatch(/extraction_status\s*=\s*EXCLUDED/i);
    expect(entityConflict).not.toMatch(/extracted_text\s*=\s*EXCLUDED/i);
    expect(entityConflict).not.toMatch(/extraction_error\s*=/i);
    expect(entityConflict).not.toMatch(/extracted_at\s*=/i);
  });

  it('reconciles only reserved automatic receipt, payslip, and statement edges', () => {
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toMatch(
      /d\.source_kind = 'receipt'[\s\S]*l\.target_type = 'transaction'[\s\S]*l\.role = 'receipt'/,
    );
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toMatch(
      /d\.source_kind = 'payslip'[\s\S]*l\.target_type = 'transaction'[\s\S]*l\.role = 'payslip'/,
    );
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toMatch(
      /d\.source_kind = 'statement_batch'[\s\S]*l\.target_type = 'account'[\s\S]*l\.role = 'statement'/,
    );
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("'autoSource', 'home_item.receipt_id'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).not.toMatch(/DELETE FROM gnucash_web_document_links\s*;/);
  });

  it('prunes only known orphan sources and concrete deleted target records', () => {
    for (const sourceKind of ['receipt', 'payslip', 'entity_document', 'home_item_photo', 'statement_batch']) {
      expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain(`d.source_kind = '${sourceKind}'`);
    }
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("l.target_type = 'home_item'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("l.target_type = 'membership_meeting'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).not.toContain("l.target_type = 'rental_unit'\n  AND NOT EXISTS");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).not.toContain("l.target_type = 'giving_donation'\n  AND NOT EXISTS");
  });

  it('normalizes every legacy domain status to the canonical extraction contract', () => {
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("CASE lower(r.ocr_status)");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'uploaded' THEN 'pending'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'complete' THEN 'completed'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("CASE lower(p.status)");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'needs_mapping' THEN 'completed'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'posted' THEN 'completed'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("CASE lower(b.status)");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'parsing' THEN 'processing'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL).toContain("WHEN 'reconciled' THEN 'completed'");
    expect(LEGACY_DOCUMENT_BACKFILL_SQL.match(/WHEN 'error' THEN 'failed'/g)).toHaveLength(3);
    expect(LEGACY_DOCUMENT_BACKFILL_SQL.match(/ELSE 'pending'/g)).toHaveLength(3);
  });

  it('deletes only the canonical source row', async () => {
    mocks.raw.mockResolvedValueOnce([{ id: 12 }]);
    await expect(deleteDocumentBySource(BOOK, 'entity_document', '44')).resolves.toBe(true);
    expect(mocks.raw.mock.calls[0][0]).toContain('DELETE FROM gnucash_web_documents');
    expect(mocks.raw.mock.calls[0][0]).not.toContain('gnucash_web_entity_documents');
  });
});
