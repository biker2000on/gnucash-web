import { query } from './db';

export interface Receipt {
  id: number;
  book_guid: string;
  transaction_guid: string | null;
  filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  mime_type: string;
  file_size: number;
  ocr_text: string | null;
  ocr_status: string;
  created_at: string;
  updated_at: string;
  created_by: number;
}

export interface ReceiptWithTransaction extends Receipt {
  transaction_description?: string;
  transaction_post_date?: string;
}

export async function createReceipt(data: {
  book_guid: string;
  transaction_guid: string | null;
  filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  mime_type: string;
  file_size: number;
  created_by: number;
}): Promise<Receipt> {
  const result = await query(
    `INSERT INTO gnucash_web_receipts
      (book_guid, transaction_guid, filename, storage_key, thumbnail_key, mime_type, file_size, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [data.book_guid, data.transaction_guid, data.filename, data.storage_key, data.thumbnail_key, data.mime_type, data.file_size, data.created_by]
  );
  return result.rows[0];
}

export async function getReceiptById(id: number, bookGuid: string): Promise<Receipt | null> {
  const result = await query(
    `SELECT * FROM gnucash_web_receipts WHERE id = $1 AND book_guid = $2`,
    [id, bookGuid]
  );
  return result.rows[0] || null;
}

export async function deleteReceipt(id: number, bookGuid: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM gnucash_web_receipts WHERE id = $1 AND book_guid = $2 RETURNING id`,
    [id, bookGuid]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function linkReceipt(id: number, bookGuid: string, transactionGuid: string | null): Promise<Receipt | null> {
  const result = await query(
    `UPDATE gnucash_web_receipts SET transaction_guid = $1, updated_at = NOW() WHERE id = $2 AND book_guid = $3 RETURNING *`,
    [transactionGuid, id, bookGuid]
  );
  return result.rows[0] || null;
}

export async function updateOcrResults(id: number, ocrText: string | null, status: string): Promise<void> {
  await query(
    `UPDATE gnucash_web_receipts SET ocr_text = $1, ocr_status = $2, updated_at = NOW() WHERE id = $3`,
    [ocrText, status, id]
  );
}

export async function getReceiptsForTransaction(transactionGuid: string, bookGuid: string): Promise<Receipt[]> {
  const result = await query(
    `SELECT * FROM gnucash_web_receipts WHERE transaction_guid = $1 AND book_guid = $2 ORDER BY created_at DESC`,
    [transactionGuid, bookGuid]
  );
  return result.rows;
}

export async function listReceipts(params: {
  bookGuid: string;
  limit: number;
  offset: number;
  search?: string;
  linked?: 'linked' | 'unlinked';
  startDate?: string;
  endDate?: string;
}): Promise<{ receipts: ReceiptWithTransaction[]; total: number }> {
  const conditions: string[] = ['r.book_guid = $1'];
  const values: unknown[] = [params.bookGuid];
  let paramIdx = 2;

  let searchParamIdx: number | null = null;
  if (params.search) {
    conditions.push(`r.ocr_tsvector @@ plainto_tsquery('english', $${paramIdx})`);
    values.push(params.search);
    searchParamIdx = paramIdx;
    paramIdx++;
  }

  if (params.linked === 'linked') {
    conditions.push('r.transaction_guid IS NOT NULL');
  } else if (params.linked === 'unlinked') {
    conditions.push('r.transaction_guid IS NULL');
  }

  if (params.startDate) {
    conditions.push(`r.created_at >= $${paramIdx}`);
    values.push(params.startDate);
    paramIdx++;
  }

  if (params.endDate) {
    conditions.push(`r.created_at <= $${paramIdx}`);
    values.push(params.endDate);
    paramIdx++;
  }

  const where = conditions.join(' AND ');

  const countResult = await query(
    `SELECT COUNT(*) as total FROM gnucash_web_receipts r WHERE ${where}`,
    values
  );

  const orderBy = searchParamIdx !== null
    ? `ts_rank(r.ocr_tsvector, plainto_tsquery('english', $${searchParamIdx})) DESC`
    : `r.created_at DESC`;

  const result = await query(
    `SELECT r.*, t.description as transaction_description, t.post_date as transaction_post_date
     FROM gnucash_web_receipts r
     LEFT JOIN transactions t ON t.guid = r.transaction_guid
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, params.limit, params.offset]
  );

  return {
    receipts: result.rows,
    total: parseInt(countResult.rows[0].total, 10),
  };
}

export async function updateExtractedData(id: number, data: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE gnucash_web_receipts SET extracted_data = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(data), id]
  );
}

export async function dismissMatch(id: number, bookGuid: string, transactionGuid: string): Promise<boolean> {
  const result = await query(
    `UPDATE gnucash_web_receipts
     SET extracted_data = jsonb_set(
       COALESCE(extracted_data, '{}'),
       '{dismissed_guids}',
       COALESCE(extracted_data->'dismissed_guids', '[]'::jsonb) || $1::jsonb
     ),
     updated_at = NOW()
     WHERE id = $2 AND book_guid = $3
     RETURNING id`,
    [JSON.stringify(transactionGuid), id, bookGuid]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getReceiptCountsForTransactions(
  transactionGuids: string[],
  bookGuid: string
): Promise<Record<string, number>> {
  if (transactionGuids.length === 0) return {};

  // Use ANY(array) instead of IN with individual placeholders to avoid
  // excessive bind parameters with large transaction lists
  const result = await query(
    `SELECT transaction_guid, COUNT(*) as count
     FROM gnucash_web_receipts
     WHERE book_guid = $1 AND transaction_guid = ANY($2::text[])
     GROUP BY transaction_guid`,
    [bookGuid, transactionGuids]
  );

  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    counts[row.transaction_guid] = parseInt(row.count, 10);
  }
  return counts;
}
