/**
 * Canonical document platform schema.
 *
 * The existing receipt, statement, payslip, entity-document, and home-photo
 * tables remain the systems of record for their specialised workflows.  The
 * tables below provide a shared metadata/search index and typed links without
 * moving or deleting any legacy data.
 */

export const CANONICAL_DOCUMENT_SCHEMA_SQL = `
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_canonical_documents_schema'));

  CREATE TABLE IF NOT EXISTS gnucash_web_documents (
    id SERIAL PRIMARY KEY,
    book_guid VARCHAR(32) NOT NULL REFERENCES books(guid) ON DELETE CASCADE,
    owner_user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    title VARCHAR(255),
    storage_key VARCHAR(500),
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    content_hash VARCHAR(128),
    dedupe_key VARCHAR(255),
    extraction_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    extracted_text TEXT,
    extraction_metadata JSONB,
    extraction_error TEXT,
    extracted_at TIMESTAMP,
    source_kind VARCHAR(40) NOT NULL,
    source_id VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_documents_size_nonnegative CHECK (size_bytes IS NULL OR size_bytes >= 0),
    CONSTRAINT uq_documents_source UNIQUE (book_guid, source_kind, source_id),
    CONSTRAINT uq_documents_id_book UNIQUE (id, book_guid)
  );

  CREATE TABLE IF NOT EXISTS gnucash_web_document_links (
    id SERIAL PRIMARY KEY,
    book_guid VARCHAR(32) NOT NULL,
    document_id INTEGER NOT NULL,
    target_type VARCHAR(40) NOT NULL,
    target_id VARCHAR(255) NOT NULL,
    role VARCHAR(40) NOT NULL DEFAULT 'attachment',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_document_links_document_scope
      FOREIGN KEY (document_id, book_guid)
      REFERENCES gnucash_web_documents(id, book_guid)
      ON DELETE CASCADE,
    CONSTRAINT uq_document_links_edge
      UNIQUE (document_id, target_type, target_id, role)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_book_created
    ON gnucash_web_documents(book_guid, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_book_source
    ON gnucash_web_documents(book_guid, source_kind, source_id);
  CREATE INDEX IF NOT EXISTS idx_documents_book_hash
    ON gnucash_web_documents(book_guid, content_hash)
    WHERE content_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_documents_book_dedupe
    ON gnucash_web_documents(book_guid, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_documents_book_extraction
    ON gnucash_web_documents(book_guid, extraction_status);
  CREATE INDEX IF NOT EXISTS idx_document_links_document
    ON gnucash_web_document_links(book_guid, document_id);
  CREATE INDEX IF NOT EXISTS idx_document_links_target
    ON gnucash_web_document_links(book_guid, target_type, target_id);

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'gnucash_web_documents'
      AND column_name = 'search_tsvector'
  ) THEN
    ALTER TABLE gnucash_web_documents
      ADD COLUMN search_tsvector tsvector
      GENERATED ALWAYS AS (
        to_tsvector(
          'english',
          COALESCE(title, '') || ' ' ||
          COALESCE(filename, '') || ' ' ||
          COALESCE(extracted_text, '')
        )
      ) STORED;
  END IF;

  CREATE INDEX IF NOT EXISTS idx_documents_search_fts
    ON gnucash_web_documents USING GIN (search_tsvector);
END $$;
`;

/**
 * Non-destructive, repeatable legacy index population.  Conflict updates keep
 * the canonical search row current while every specialised source row remains
 * untouched. Statement tables are optional/lazy and therefore use guarded
 * dynamic SQL.
 *
 * Every source SELECT carries `JOIN books bk_guard` because the source tables
 * (receipts, payslips, home items, statement batches) have no FK on their own
 * `book_guid`, while `gnucash_web_documents.book_guid` REFERENCES books(guid).
 * Without the join a single orphaned source row aborts the whole backfill on
 * every boot. Skipping orphans is correct here: a row pointing at a book that
 * no longer exists has nothing to be indexed against.
 */
export const LEGACY_DOCUMENT_BACKFILL_SQL = `
INSERT INTO gnucash_web_documents (
  book_guid, owner_user_id, title, storage_key, filename, mime_type, size_bytes,
  extraction_status, extracted_text, extraction_metadata,
  source_kind, source_id, created_at, updated_at
)
SELECT
  r.book_guid, r.created_by, r.filename, r.storage_key, r.filename,
  r.mime_type, r.file_size::BIGINT,
  CASE lower(r.ocr_status)
    WHEN 'pending' THEN 'pending'
    WHEN 'uploaded' THEN 'pending'
    WHEN 'processing' THEN 'processing'
    WHEN 'complete' THEN 'completed'
    WHEN 'completed' THEN 'completed'
    WHEN 'error' THEN 'failed'
    WHEN 'failed' THEN 'failed'
    WHEN 'skipped' THEN 'skipped'
    ELSE 'pending'
  END,
  r.ocr_text,
  r.extracted_data, 'receipt', r.id::TEXT, r.created_at, r.updated_at
FROM gnucash_web_receipts r
JOIN books bk_guard ON bk_guard.guid = r.book_guid
ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
  owner_user_id = EXCLUDED.owner_user_id,
  storage_key = EXCLUDED.storage_key,
  filename = EXCLUDED.filename,
  mime_type = EXCLUDED.mime_type,
  size_bytes = EXCLUDED.size_bytes,
  extraction_status = EXCLUDED.extraction_status,
  extracted_text = EXCLUDED.extracted_text,
  extraction_metadata = EXCLUDED.extraction_metadata,
  updated_at = EXCLUDED.updated_at;

INSERT INTO gnucash_web_documents (
  book_guid, owner_user_id, title, storage_key, filename, mime_type,
  extraction_status, extracted_text, extraction_metadata,
  source_kind, source_id, created_at, updated_at
)
SELECT
  p.book_guid, p.created_by, p.employer_name, p.storage_key,
  p.employer_name || '-' || p.pay_date::TEXT || '.pdf',
  CASE WHEN p.storage_key IS NULL THEN NULL ELSE 'application/pdf' END,
  CASE lower(p.status)
    WHEN 'pending' THEN 'pending'
    WHEN 'uploaded' THEN 'pending'
    WHEN 'processing' THEN 'processing'
    WHEN 'error' THEN 'failed'
    WHEN 'failed' THEN 'failed'
    WHEN 'complete' THEN 'completed'
    WHEN 'completed' THEN 'completed'
    WHEN 'ready' THEN 'completed'
    WHEN 'needs_mapping' THEN 'completed'
    WHEN 'posted' THEN 'completed'
    WHEN 'parsed' THEN 'completed'
    WHEN 'skipped' THEN 'skipped'
    ELSE 'pending'
  END,
  concat_ws(' ', p.employer_name, p.line_items::TEXT),
  jsonb_build_object('line_items', p.line_items, 'raw_response', p.raw_response),
  'payslip', p.id::TEXT, p.created_at, p.updated_at
FROM gnucash_web_payslips p
JOIN books bk_guard ON bk_guard.guid = p.book_guid
ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
  owner_user_id = EXCLUDED.owner_user_id,
  title = EXCLUDED.title,
  storage_key = EXCLUDED.storage_key,
  filename = EXCLUDED.filename,
  mime_type = EXCLUDED.mime_type,
  extraction_status = EXCLUDED.extraction_status,
  extracted_text = EXCLUDED.extracted_text,
  extraction_metadata = EXCLUDED.extraction_metadata,
  updated_at = EXCLUDED.updated_at;

INSERT INTO gnucash_web_documents (
  book_guid, title, storage_key, filename, mime_type, size_bytes,
  extraction_status, extracted_text, extraction_metadata,
  source_kind, source_id, created_at, updated_at
)
SELECT
  e.book_guid, e.title, e.file_key, COALESCE(e.file_name, e.title),
  e.mime_type, e.size_bytes, 'not_applicable', e.notes,
  jsonb_build_object(
    'docType', e.doc_type,
    'expiresOn', e.expires_on,
    'issuedOn', e.issued_on,
    'returnCopyDueOn', e.return_copy_due_on,
    'notes', e.notes
  ),
  'entity_document', e.id::TEXT, e.uploaded_at, e.uploaded_at
FROM gnucash_web_entity_documents e
JOIN books bk_guard ON bk_guard.guid = e.book_guid
ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  storage_key = EXCLUDED.storage_key,
  filename = EXCLUDED.filename,
  mime_type = EXCLUDED.mime_type,
  size_bytes = EXCLUDED.size_bytes,
  extraction_metadata = COALESCE(gnucash_web_documents.extraction_metadata, '{}'::jsonb)
    || COALESCE(EXCLUDED.extraction_metadata, '{}'::jsonb),
  updated_at = GREATEST(gnucash_web_documents.updated_at, EXCLUDED.updated_at);

INSERT INTO gnucash_web_documents (
  book_guid, title, storage_key, filename, mime_type,
  extraction_status, extraction_metadata,
  source_kind, source_id, created_at, updated_at
)
SELECT
  p.book_guid, i.name, p.photo_key,
  regexp_replace(p.photo_key, '^.*/', ''),
  CASE
    WHEN lower(p.photo_key) ~ '\\.(jpe?g)$' THEN 'image/jpeg'
    WHEN lower(p.photo_key) ~ '\\.png$' THEN 'image/png'
    WHEN lower(p.photo_key) ~ '\\.webp$' THEN 'image/webp'
    ELSE 'application/octet-stream'
  END,
  'not_applicable',
  jsonb_build_object('item_id', p.item_id, 'sort_order', p.sort_order),
  'home_item_photo', p.id::TEXT, p.created_at, p.created_at
FROM gnucash_web_home_item_photos p
JOIN books bk_guard ON bk_guard.guid = p.book_guid
JOIN gnucash_web_home_items i ON i.id = p.item_id AND i.book_guid = p.book_guid
ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  storage_key = EXCLUDED.storage_key,
  filename = EXCLUDED.filename,
  mime_type = EXCLUDED.mime_type,
  extraction_metadata = EXCLUDED.extraction_metadata,
  updated_at = EXCLUDED.updated_at;

DO $legacy_documents$
BEGIN
  IF to_regclass('gnucash_web_statement_batches') IS NOT NULL
     AND to_regclass('gnucash_web_statement_lines') IS NOT NULL THEN
    EXECUTE $statement_backfill$
      INSERT INTO gnucash_web_documents (
        book_guid, title, storage_key, filename, mime_type,
        extraction_status, extracted_text, extraction_metadata,
        source_kind, source_id, created_at, updated_at
      )
      SELECT
        b.book_guid, b.original_filename, b.storage_key, b.original_filename,
        CASE b.source
          WHEN 'pdf' THEN 'application/pdf'
          WHEN 'csv' THEN 'text/csv'
          WHEN 'ofx' THEN 'application/x-ofx'
          ELSE 'application/octet-stream'
        END,
        CASE lower(b.status)
          WHEN 'pending' THEN 'pending'
          WHEN 'uploaded' THEN 'pending'
          WHEN 'parsing' THEN 'processing'
          WHEN 'processing' THEN 'processing'
          WHEN 'error' THEN 'failed'
          WHEN 'failed' THEN 'failed'
          WHEN 'parsed' THEN 'completed'
          WHEN 'reconciled' THEN 'completed'
          WHEN 'complete' THEN 'completed'
          WHEN 'completed' THEN 'completed'
          WHEN 'skipped' THEN 'skipped'
          ELSE 'pending'
        END,
        (
          SELECT string_agg(l.description, ' ' ORDER BY l.line_date, l.id)
          FROM gnucash_web_statement_lines l
          WHERE l.batch_id = b.id
        ),
        jsonb_build_object(
          'source', b.source,
          'account_guid', b.account_guid,
          'statement_start_date', b.statement_start_date,
          'statement_end_date', b.statement_end_date
        ),
        'statement_batch', b.id::TEXT, b.created_at, b.updated_at
      FROM gnucash_web_statement_batches b
      JOIN books bk_guard ON bk_guard.guid = b.book_guid
      ON CONFLICT (book_guid, source_kind, source_id) DO UPDATE SET
        title = EXCLUDED.title,
        storage_key = EXCLUDED.storage_key,
        filename = EXCLUDED.filename,
        mime_type = EXCLUDED.mime_type,
        extraction_status = EXCLUDED.extraction_status,
        extracted_text = EXCLUDED.extracted_text,
        extraction_metadata = EXCLUDED.extraction_metadata,
        updated_at = EXCLUDED.updated_at
    $statement_backfill$;

    EXECUTE $statement_orphan_cleanup$
      DELETE FROM gnucash_web_documents d
      WHERE d.source_kind = 'statement_batch'
        AND NOT EXISTS (
          SELECT 1
          FROM gnucash_web_statement_batches b
          WHERE b.book_guid = d.book_guid
            AND b.id::TEXT = d.source_id
        )
    $statement_orphan_cleanup$;
  END IF;
END $legacy_documents$;

-- Canonical rows are derived sidecars. Prune only recognised specialised
-- sources after their authoritative tables confirm deletion; FK cascades then
-- remove both automatic and manual links without risking link loss on a
-- failed source deletion.
DELETE FROM gnucash_web_documents d
WHERE d.source_kind = 'receipt'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_receipts r
    WHERE r.book_guid = d.book_guid AND r.id::TEXT = d.source_id
  );

DELETE FROM gnucash_web_documents d
WHERE d.source_kind = 'payslip'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_payslips p
    WHERE p.book_guid = d.book_guid AND p.id::TEXT = d.source_id
  );

DELETE FROM gnucash_web_documents d
WHERE d.source_kind = 'entity_document'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_entity_documents e
    WHERE e.book_guid = d.book_guid AND e.id::TEXT = d.source_id
  );

DELETE FROM gnucash_web_documents d
WHERE d.source_kind = 'home_item_photo'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_home_item_photos p
    WHERE p.book_guid = d.book_guid AND p.id::TEXT = d.source_id
  );

-- Target links are also derived once a home item no longer exists. This is
-- intentionally target-scoped and does not delete the linked documents.
DELETE FROM gnucash_web_document_links l
WHERE l.target_type = 'home_item'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_home_items i
    WHERE i.book_guid = l.book_guid AND i.id::TEXT = l.target_id
  );

DELETE FROM gnucash_web_document_links l
WHERE l.target_type = 'membership_meeting'
  AND NOT EXISTS (
    SELECT 1 FROM gnucash_web_meetings m
    WHERE m.book_guid = l.book_guid AND m.id::TEXT = l.target_id
  );

-- Reconcile only the canonical platform's reserved receipt edge. Other roles
-- and target types are user-managed feature links and remain untouched.
DELETE FROM gnucash_web_document_links l
USING gnucash_web_documents d
WHERE l.document_id = d.id
  AND l.book_guid = d.book_guid
  AND d.source_kind = 'receipt'
  AND l.target_type = 'transaction'
  AND l.role = 'receipt'
  AND NOT EXISTS (
    SELECT 1
    FROM gnucash_web_receipts r
    WHERE r.book_guid = d.book_guid
      AND r.id::TEXT = d.source_id
      AND r.transaction_guid = l.target_id
  );

INSERT INTO gnucash_web_document_links (
  book_guid, document_id, target_type, target_id, role, metadata
)
SELECT r.book_guid, d.id, 'transaction', r.transaction_guid, 'receipt',
       jsonb_build_object(
         'legacy_receipt_id', r.id,
         'autoSource', 'gnucash_web_receipts.transaction_guid'
       )
FROM gnucash_web_receipts r
JOIN books bk_guard ON bk_guard.guid = r.book_guid
JOIN gnucash_web_documents d
  ON d.book_guid = r.book_guid
 AND d.source_kind = 'receipt'
 AND d.source_id = r.id::TEXT
WHERE r.transaction_guid IS NOT NULL
ON CONFLICT (document_id, target_type, target_id, role) DO NOTHING;

DELETE FROM gnucash_web_document_links l
USING gnucash_web_documents d
WHERE l.document_id = d.id
  AND l.book_guid = d.book_guid
  AND d.source_kind = 'payslip'
  AND l.target_type = 'transaction'
  AND l.role = 'payslip'
  AND NOT EXISTS (
    SELECT 1
    FROM gnucash_web_payslips p
    WHERE p.book_guid = d.book_guid
      AND p.id::TEXT = d.source_id
      AND p.transaction_guid = l.target_id
  );

INSERT INTO gnucash_web_document_links (
  book_guid, document_id, target_type, target_id, role, metadata
)
SELECT p.book_guid, d.id, 'transaction', p.transaction_guid, 'payslip',
       jsonb_build_object(
         'legacy_payslip_id', p.id,
         'autoSource', 'gnucash_web_payslips.transaction_guid'
       )
FROM gnucash_web_payslips p
JOIN books bk_guard ON bk_guard.guid = p.book_guid
JOIN gnucash_web_documents d
  ON d.book_guid = p.book_guid
 AND d.source_kind = 'payslip'
 AND d.source_id = p.id::TEXT
WHERE p.transaction_guid IS NOT NULL
ON CONFLICT (document_id, target_type, target_id, role) DO NOTHING;

INSERT INTO gnucash_web_document_links (
  book_guid, document_id, target_type, target_id, role, metadata
)
SELECT p.book_guid, d.id, 'home_item', p.item_id::TEXT, 'photo',
       jsonb_build_object('legacy_photo_id', p.id)
FROM gnucash_web_home_item_photos p
JOIN books bk_guard ON bk_guard.guid = p.book_guid
JOIN gnucash_web_documents d
  ON d.book_guid = p.book_guid
 AND d.source_kind = 'home_item_photo'
 AND d.source_id = p.id::TEXT
ON CONFLICT (document_id, target_type, target_id, role) DO NOTHING;

DELETE FROM gnucash_web_document_links l
USING gnucash_web_documents d
WHERE l.document_id = d.id
  AND l.book_guid = d.book_guid
  AND d.source_kind = 'receipt'
  AND l.target_type = 'home_item'
  AND l.role = 'purchase_receipt'
  AND (
    l.metadata ? 'legacy_receipt_id'
    OR l.metadata ->> 'autoSource' = 'home_item.receipt_id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM gnucash_web_home_items i
    WHERE i.book_guid = d.book_guid
      AND i.id::TEXT = l.target_id
      AND i.receipt_id::TEXT = d.source_id
  );

INSERT INTO gnucash_web_document_links (
  book_guid, document_id, target_type, target_id, role, metadata
)
SELECT i.book_guid, d.id, 'home_item', i.id::TEXT, 'purchase_receipt',
       jsonb_build_object(
         'legacy_receipt_id', i.receipt_id,
         'autoSource', 'home_item.receipt_id'
       )
FROM gnucash_web_home_items i
JOIN books bk_guard ON bk_guard.guid = i.book_guid
JOIN gnucash_web_documents d
  ON d.book_guid = i.book_guid
 AND d.source_kind = 'receipt'
 AND d.source_id = i.receipt_id::TEXT
WHERE i.receipt_id IS NOT NULL
ON CONFLICT (document_id, target_type, target_id, role) DO NOTHING;

DO $legacy_statement_links$
BEGIN
  IF to_regclass('gnucash_web_statement_batches') IS NOT NULL THEN
    EXECUTE $statement_link_cleanup$
      DELETE FROM gnucash_web_document_links l
      USING gnucash_web_documents d
      WHERE l.document_id = d.id
        AND l.book_guid = d.book_guid
        AND d.source_kind = 'statement_batch'
        AND l.target_type = 'account'
        AND l.role = 'statement'
        AND NOT EXISTS (
          SELECT 1
          FROM gnucash_web_statement_batches b
          WHERE b.book_guid = d.book_guid
            AND b.id::TEXT = d.source_id
            AND b.account_guid = l.target_id
        )
    $statement_link_cleanup$;

    EXECUTE $statement_links$
      INSERT INTO gnucash_web_document_links (
        book_guid, document_id, target_type, target_id, role, metadata
      )
      SELECT b.book_guid, d.id, 'account', b.account_guid, 'statement',
             jsonb_build_object(
               'legacy_statement_batch_id', b.id,
               'autoSource', 'gnucash_web_statement_batches.account_guid'
             )
      FROM gnucash_web_statement_batches b
      JOIN books bk_guard ON bk_guard.guid = b.book_guid
      JOIN gnucash_web_documents d
        ON d.book_guid = b.book_guid
       AND d.source_kind = 'statement_batch'
       AND d.source_id = b.id::TEXT
      WHERE b.account_guid IS NOT NULL
      ON CONFLICT (document_id, target_type, target_id, role) DO NOTHING
    $statement_links$;
  END IF;
END $legacy_statement_links$;
`;
