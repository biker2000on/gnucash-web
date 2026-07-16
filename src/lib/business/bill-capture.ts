/**
 * Bill capture via email — DRAFT vendor bills from inbound attachments.
 *
 * Emails to the ingest mailbox whose subject starts with "bill" (or whose
 * allowlisted sender has default_kind = 'bill') flow through here on
 * BUSINESS books:
 *
 *   1. captureBillFromEmail() stores the attachment through the normal
 *      receipt intake (same storage/thumbnail/OCR pipeline) and records a
 *      pending row in the lazily-created gnucash_web_email_bills table.
 *   2. When the ocr-receipt job finishes extraction it calls
 *      processPendingEmailBill(): vendor name is matched against the native
 *      `vendors` table (case/punctuation-insensitive — nothing is created
 *      automatically). A match creates an UNPOSTED (draft) bill through the
 *      invoice engine with a single line to 'Expenses:Uncategorized';
 *      no match (or no usable amount) parks the row in 'needs_review'.
 *   3. The Bills page surfaces drafted bills with a "from email" badge and a
 *      review queue where needs_review rows get a vendor picked (creating
 *      the draft) or are dismissed.
 *
 * On personal (household) books the attachment is still ingested as a plain
 * receipt — nothing bill-related is created.
 */

import prisma from '@/lib/prisma';
import { intakeReceipt } from '@/lib/services/document-intake';
import { createInvoice } from './invoice-engine';
import { findOrCreateAccount } from '@/lib/gnucash';

export const EMAIL_BILL_EXPENSE_PATH = 'Expenses:Uncategorized';

export type EmailBillStatus =
  | 'pending_extraction'
  | 'needs_review'
  | 'drafted'
  | 'dismissed'
  | 'error';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Normalize a vendor name for matching: lowercase, strip punctuation and
 * common corporate suffixes, collapse whitespace.
 */
export function normalizeVendorName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match an extracted vendor name against the vendor list. Exact normalized
 * match wins; a unique prefix/containment match is accepted as a fallback
 * (e.g. "Acme Power" vs vendor "Acme Power & Light"). Ambiguous or empty →
 * null (nothing is ever created automatically).
 */
export function matchVendorByName<T extends { guid: string; name: string }>(
  extractedName: string | null | undefined,
  vendors: T[],
): T | null {
  const needle = normalizeVendorName(extractedName);
  if (!needle) return null;

  const normalized = vendors.map(v => ({ vendor: v, norm: normalizeVendorName(v.name) }));

  const exact = normalized.filter(v => v.norm !== '' && v.norm === needle);
  if (exact.length === 1) return exact[0].vendor;
  if (exact.length > 1) return null;

  const partial = normalized.filter(
    v => v.norm !== '' && (v.norm.includes(needle) || needle.includes(v.norm)),
  );
  return partial.length === 1 ? partial[0].vendor : null;
}

// ---------------------------------------------------------------------------
// Lazy table (advisory-lock pattern, same as email-ingest.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureEmailBillTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_email_bills_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_email_bills (
            id SERIAL PRIMARY KEY,
            receipt_id INTEGER NOT NULL,
            book_guid VARCHAR(32) NOT NULL,
            user_id INTEGER NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'pending_extraction',
            subject VARCHAR(500),
            filename VARCHAR(255),
            vendor_name VARCHAR(255),
            vendor_guid VARCHAR(32),
            amount NUMERIC(20, 2),
            doc_date DATE,
            invoice_guid VARCHAR(32),
            detail TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_email_bills_receipt
            ON gnucash_web_email_bills(receipt_id);
          CREATE INDEX IF NOT EXISTS idx_email_bills_book_status
            ON gnucash_web_email_bills(book_guid, status);
        END $$;
      `);
    })();
    ensurePromise.catch(() => { ensurePromise = null; });
  }
  return ensurePromise;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export interface EmailBill {
  id: number;
  receiptId: number;
  bookGuid: string;
  userId: number;
  status: EmailBillStatus;
  subject: string | null;
  filename: string | null;
  vendorName: string | null;
  vendorGuid: string | null;
  amount: number | null;
  docDate: string | null;
  invoiceGuid: string | null;
  detail: string | null;
  createdAt: Date;
}

interface EmailBillRow {
  id: number;
  receipt_id: number;
  book_guid: string;
  user_id: number;
  status: string;
  subject: string | null;
  filename: string | null;
  vendor_name: string | null;
  vendor_guid: string | null;
  amount: unknown;
  doc_date: Date | null;
  invoice_guid: string | null;
  detail: string | null;
  created_at: Date;
}

function rowToEmailBill(row: EmailBillRow): EmailBill {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    bookGuid: row.book_guid,
    userId: row.user_id,
    status: row.status as EmailBillStatus,
    subject: row.subject,
    filename: row.filename,
    vendorName: row.vendor_name,
    vendorGuid: row.vendor_guid,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    docDate: row.doc_date ? row.doc_date.toISOString().slice(0, 10) : null,
    invoiceGuid: row.invoice_guid,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Capture (called by the email-ingest poller)
// ---------------------------------------------------------------------------

async function isBusinessBook(bookGuid: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ entity_type: string }>>`
    SELECT entity_type FROM gnucash_web_entity_profiles
    WHERE book_guid = ${bookGuid}
    LIMIT 1`;
  return rows.length > 0 && rows[0].entity_type !== 'household';
}

export interface CaptureBillInput {
  bookGuid: string;
  userId: number;
  filename: string;
  buffer: Buffer;
  subject?: string | null;
}

export type CaptureBillResult =
  | { ok: true; receiptId: number; billTracked: boolean; note?: string }
  | { ok: false; error: string };

/**
 * Ingest one bill attachment: store it as a receipt (thumbnail + OCR job as
 * usual) and, on business books, track it in gnucash_web_email_bills so the
 * post-extraction hook can draft the vendor bill. On personal books the
 * receipt is stored but no bill row is created.
 */
export async function captureBillFromEmail(input: CaptureBillInput): Promise<CaptureBillResult> {
  const intake = await intakeReceipt({
    bookGuid: input.bookGuid,
    userId: input.userId,
    filename: input.filename,
    buffer: input.buffer,
    transactionGuid: null,
  });
  if (!intake.ok) {
    return { ok: false, error: intake.error };
  }

  let business = false;
  try {
    business = await isBusinessBook(input.bookGuid);
  } catch (err) {
    console.warn('[bill-capture] Entity-profile lookup failed; treating as personal book:', err);
  }
  if (!business) {
    return {
      ok: true,
      receiptId: intake.id,
      billTracked: false,
      note: 'not a business book — stored as a plain receipt',
    };
  }

  await ensureEmailBillTable();
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_email_bills (receipt_id, book_guid, user_id, status, subject, filename)
    VALUES (
      ${intake.id},
      ${input.bookGuid},
      ${input.userId},
      'pending_extraction',
      ${input.subject?.slice(0, 500) ?? null},
      ${intake.filename.slice(0, 255)}
    )
    ON CONFLICT (receipt_id) DO NOTHING`;

  return { ok: true, receiptId: intake.id, billTracked: true };
}

// ---------------------------------------------------------------------------
// Post-extraction processing (called from the ocr-receipt job)
// ---------------------------------------------------------------------------

interface ExtractedBillData {
  amount: number | null;
  date: string | null;
  vendor: string | null;
  vendorNormalized: string | null;
}

function readExtracted(data: Record<string, unknown> | null | undefined): ExtractedBillData {
  const amount = typeof data?.amount === 'number' && Number.isFinite(data.amount)
    ? data.amount
    : null;
  const date = typeof data?.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(data.date)
    ? data.date.slice(0, 10)
    : null;
  const vendor = typeof data?.vendor === 'string' && data.vendor.trim() ? data.vendor.trim() : null;
  const vendorNormalized = typeof data?.vendor_normalized === 'string' && data.vendor_normalized.trim()
    ? data.vendor_normalized.trim()
    : null;
  return { amount, date, vendor, vendorNormalized };
}

async function createDraftBill(params: {
  bookGuid: string;
  vendorGuid: string;
  vendorCurrencyGuid: string;
  amount: number;
  date: string | null;
  description: string;
}): Promise<string> {
  const book = await prisma.books.findUnique({
    where: { guid: params.bookGuid },
    select: { root_account_guid: true },
  });
  if (!book) throw new Error(`Book not found: ${params.bookGuid}`);

  const expenseAccountGuid = await findOrCreateAccount(
    EMAIL_BILL_EXPENSE_PATH,
    book.root_account_guid,
    params.vendorCurrencyGuid,
  );

  const invoice = await createInvoice({
    ownerType: 'vendor',
    ownerGuid: params.vendorGuid,
    dateOpened: params.date ?? undefined,
    notes: `Created from email by gnucash-web bill capture. Review the line item before posting.`,
    entries: [
      {
        description: params.description,
        quantity: 1,
        price: params.amount,
        accountGuid: expenseAccountGuid,
      },
    ],
    bookGuid: params.bookGuid,
  });
  return invoice.guid;
}

/**
 * Called after receipt OCR + extraction: if the receipt has a pending
 * email-bill row, match the extracted vendor and either draft the bill or
 * park the row for review. Never throws — a bill-capture failure must not
 * fail the OCR job.
 */
export async function processPendingEmailBill(receiptId: number): Promise<void> {
  try {
    await ensureEmailBillTable();
    const rows = await prisma.$queryRaw<EmailBillRow[]>`
      SELECT * FROM gnucash_web_email_bills
      WHERE receipt_id = ${receiptId} AND status = 'pending_extraction'
      LIMIT 1`;
    if (rows.length === 0) return;
    const bill = rowToEmailBill(rows[0]);

    const receiptRows = await prisma.$queryRaw<Array<{ extracted_data: Record<string, unknown> | null }>>`
      SELECT extracted_data FROM gnucash_web_receipts WHERE id = ${receiptId} LIMIT 1`;
    const extracted = readExtracted(receiptRows[0]?.extracted_data);

    const vendors = await prisma.vendors.findMany({
      where: { active: 1 },
      select: { guid: true, name: true, currency: true },
    });
    const matched =
      matchVendorByName(extracted.vendor, vendors) ??
      matchVendorByName(extracted.vendorNormalized, vendors);

    if (matched && extracted.amount !== null && extracted.amount > 0) {
      const invoiceGuid = await createDraftBill({
        bookGuid: bill.bookGuid,
        vendorGuid: matched.guid,
        vendorCurrencyGuid: matched.currency,
        amount: extracted.amount,
        date: extracted.date,
        description: bill.subject?.replace(/^\s*bill\b[:\s-]*/i, '').trim()
          || bill.filename
          || 'Bill from email',
      });
      await prisma.$executeRaw`
        UPDATE gnucash_web_email_bills
        SET status = 'drafted',
            vendor_name = ${extracted.vendor},
            vendor_guid = ${matched.guid},
            amount = ${extracted.amount},
            doc_date = ${extracted.date ? new Date(extracted.date + 'T12:00:00Z') : null},
            invoice_guid = ${invoiceGuid},
            detail = ${'Matched vendor: ' + matched.name},
            updated_at = NOW()
        WHERE id = ${bill.id}`;
      console.log(`[bill-capture] Drafted bill ${invoiceGuid} for receipt ${receiptId} (vendor ${matched.name})`);
      return;
    }

    const reason = !matched
      ? extracted.vendor
        ? `No unique vendor match for "${extracted.vendor}"`
        : 'No vendor name extracted'
      : 'No usable amount extracted';
    await prisma.$executeRaw`
      UPDATE gnucash_web_email_bills
      SET status = 'needs_review',
          vendor_name = ${extracted.vendor},
          amount = ${extracted.amount},
          doc_date = ${extracted.date ? new Date(extracted.date + 'T12:00:00Z') : null},
          detail = ${reason},
          updated_at = NOW()
      WHERE id = ${bill.id}`;
    console.log(`[bill-capture] Receipt ${receiptId} needs review: ${reason}`);
  } catch (err) {
    console.error(`[bill-capture] Failed to process email bill for receipt ${receiptId}:`, err);
    try {
      await prisma.$executeRaw`
        UPDATE gnucash_web_email_bills
        SET status = 'error',
            detail = ${err instanceof Error ? err.message : String(err)},
            updated_at = NOW()
        WHERE receipt_id = ${receiptId} AND status = 'pending_extraction'`;
    } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Review-queue API surface
// ---------------------------------------------------------------------------

/** All email-bill rows for a book (newest first), optionally by status. */
export async function listEmailBills(
  bookGuid: string,
  statuses?: EmailBillStatus[],
): Promise<EmailBill[]> {
  await ensureEmailBillTable();
  const rows = statuses && statuses.length > 0
    ? await prisma.$queryRaw<EmailBillRow[]>`
        SELECT * FROM gnucash_web_email_bills
        WHERE book_guid = ${bookGuid} AND status = ANY(${statuses}::text[])
        ORDER BY created_at DESC, id DESC`
    : await prisma.$queryRaw<EmailBillRow[]>`
        SELECT * FROM gnucash_web_email_bills
        WHERE book_guid = ${bookGuid}
        ORDER BY created_at DESC, id DESC`;
  return rows.map(rowToEmailBill);
}

export class EmailBillNotFoundError extends Error {}
export class EmailBillStateError extends Error {}

/**
 * Resolve a needs_review capture: create the draft bill for the chosen
 * vendor (amount override optional when extraction found none).
 */
export async function resolveEmailBill(params: {
  id: number;
  bookGuid: string;
  vendorGuid: string;
  amount?: number | null;
  date?: string | null;
}): Promise<EmailBill> {
  await ensureEmailBillTable();
  const rows = await prisma.$queryRaw<EmailBillRow[]>`
    SELECT * FROM gnucash_web_email_bills
    WHERE id = ${params.id} AND book_guid = ${params.bookGuid}
    LIMIT 1`;
  if (rows.length === 0) throw new EmailBillNotFoundError(`Email bill not found: ${params.id}`);
  const bill = rowToEmailBill(rows[0]);
  // pending_extraction is resolvable too: extraction can be stuck (queue
  // down) and the user shouldn't have to wait to draft the bill manually.
  if (bill.status !== 'needs_review' && bill.status !== 'error' && bill.status !== 'pending_extraction') {
    throw new EmailBillStateError(`Email bill ${params.id} is ${bill.status}, not awaiting review`);
  }

  const vendor = await prisma.vendors.findUnique({
    where: { guid: params.vendorGuid },
    select: { guid: true, name: true, currency: true },
  });
  if (!vendor) throw new EmailBillNotFoundError(`Vendor not found: ${params.vendorGuid}`);

  const amount = params.amount ?? bill.amount;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    throw new EmailBillStateError('An amount greater than zero is required to draft the bill');
  }
  const date = params.date ?? bill.docDate;

  const invoiceGuid = await createDraftBill({
    bookGuid: bill.bookGuid,
    vendorGuid: vendor.guid,
    vendorCurrencyGuid: vendor.currency,
    amount,
    date,
    description: bill.subject?.replace(/^\s*bill\b[:\s-]*/i, '').trim()
      || bill.filename
      || 'Bill from email',
  });

  const updated = await prisma.$queryRaw<EmailBillRow[]>`
    UPDATE gnucash_web_email_bills
    SET status = 'drafted',
        vendor_guid = ${vendor.guid},
        amount = ${amount},
        doc_date = ${date ? new Date(date + 'T12:00:00Z') : null},
        invoice_guid = ${invoiceGuid},
        detail = ${'Resolved manually to vendor: ' + vendor.name},
        updated_at = NOW()
    WHERE id = ${bill.id}
    RETURNING *`;
  return rowToEmailBill(updated[0]);
}

/** Dismiss a capture from the review queue (the receipt itself remains). */
export async function dismissEmailBill(id: number, bookGuid: string): Promise<boolean> {
  await ensureEmailBillTable();
  const count = await prisma.$executeRaw`
    UPDATE gnucash_web_email_bills
    SET status = 'dismissed', updated_at = NOW()
    WHERE id = ${id} AND book_guid = ${bookGuid}
      AND status IN ('needs_review', 'error', 'pending_extraction')`;
  return count > 0;
}
