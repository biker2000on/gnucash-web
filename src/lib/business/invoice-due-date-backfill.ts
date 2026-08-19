/**
 * Legacy `trans-date-due` backfill.
 *
 * `postInvoice` persists the resolved due date as a `trans-date-due` slot on
 * the posting transaction, and every reader (the invoice view, the aging
 * report, the dunning job) takes it from there. Invoices posted BEFORE that
 * slot existed have no such slot, so `resolveAgingDueDate` falls back to the
 * post date and flags the result `dueDateInferred`. The dunning job refuses to
 * escalate on an inferred due date (see `shouldSkipDunningForInferredDueDate`)
 * — so those invoices are silently never dunned, no matter how overdue.
 *
 * This module recomputes the due date for exactly those transactions the way
 * posting would have (bill terms > post date, via the same `computeDueDate`)
 * and writes the missing slot.
 *
 * It cannot recover an explicit per-post due-date OVERRIDE — that was never
 * stored anywhere else — so an overridden legacy invoice gets its terms-based
 * due date. That is still strictly better than the post-date fallback it has
 * today, and it is the same date the pre-slot UI displayed.
 *
 * Idempotent and book-agnostic: it only touches posted invoices whose posting
 * transaction has NO `trans-date-due` slot at all, so a second run selects
 * nothing. Run as a one-shot migration step from db-init.
 */

import { computeDueDate, type BillTermSpec } from './invoice-totals';

/** GnuCash KvpValue::Type for a timespec slot (mirrors invoice-engine). */
export const SLOT_TIMESPEC = 6;

/** One posted invoice whose posting transaction is missing the due-date slot. */
export interface LegacyPostedInvoice {
  invoiceGuid: string;
  /** GUID of the posting transaction — the slot's obj_guid. */
  postTxnGuid: string;
  /** The posting transaction's post_date, i.e. the date posting used. */
  postDate: Date;
  /** The invoice's bill terms, or null when it has none. */
  term: BillTermSpec | null;
}

/**
 * The due date posting WOULD have written for a legacy invoice.
 *
 * Deliberately the same call `postInvoice` makes (`computeDueDate(postDate,
 * term)`): terms drive it, and a missing/day-less term means "due on the post
 * date". Keeping this a one-line pure function is the point — the backfill and
 * the post path must never grow two different notions of "due".
 */
export function computeLegacyInvoiceDueDate(invoice: LegacyPostedInvoice): Date {
  return computeDueDate(invoice.postDate, invoice.term);
}

export interface DueDateBackfillResult {
  /** Posted invoices found with no `trans-date-due` slot. */
  candidates: number;
  /** Slots written. */
  written: number;
  /**
   * Candidates skipped because the posting transaction had no post_date —
   * there is nothing to compute a due date from, and inventing one would be
   * worse than leaving the invoice inferred.
   */
  skippedNoPostDate: number;
  /**
   * Posted invoices that DO carry a `trans-date-due` slot of some other slot
   * type. Readers filter on the timespec type, so these stay inferred; writing
   * a second slot of the same name is not something this backfill will do
   * blind. Reported so the count is visible rather than silently wrong.
   */
  wrongSlotType: number;
}

/** Minimal prisma surface this backfill needs — keeps the unit test honest. */
export interface DueDateBackfillDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  slots: {
    createMany(args: {
      data: Array<{
        obj_guid: string;
        name: string;
        slot_type: number;
        timespec_val: Date;
      }>;
    }): Promise<{ count: number }>;
  };
}

interface CandidateRow {
  invoice_guid: string;
  post_txn: string;
  post_date: Date | null;
  term_type: string | null;
  term_duedays: number | null;
  term_cutoff: number | null;
  other_type_slots: bigint | number;
}

/** Insert in chunks so one book's history cannot build a single huge statement. */
const WRITE_CHUNK = 500;

/**
 * Write the missing `trans-date-due` slots. Returns what it found and did.
 *
 * Book-agnostic on purpose: this repairs a schema-era gap, not a user action,
 * and db-init has no active book. Safe to run concurrently with the app — the
 * SELECT and the INSERT both key off "slot absent", so a racing `postInvoice`
 * (which writes the slot inside its own transaction) either has not created
 * the invoice yet or already wrote the slot.
 */
export async function backfillInvoiceDueDateSlots(
  db: DueDateBackfillDb,
): Promise<DueDateBackfillResult> {
  const rows = await db.$queryRaw<CandidateRow[]>`
    SELECT i.guid            AS invoice_guid,
           i.post_txn        AS post_txn,
           t.post_date       AS post_date,
           bt.type           AS term_type,
           bt.duedays        AS term_duedays,
           bt.cutoff         AS term_cutoff,
           (SELECT COUNT(*) FROM slots s2
             WHERE s2.obj_guid = i.post_txn
               AND s2.name = 'trans-date-due') AS other_type_slots
    FROM invoices i
    JOIN transactions t ON t.guid = i.post_txn
    LEFT JOIN billterms bt ON bt.guid = i.terms
    WHERE i.post_txn IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM slots s
        WHERE s.obj_guid = i.post_txn
          AND s.name = 'trans-date-due'
          AND s.slot_type = ${SLOT_TIMESPEC}
      )
  `;

  const result: DueDateBackfillResult = {
    candidates: 0,
    written: 0,
    skippedNoPostDate: 0,
    wrongSlotType: 0,
  };

  const pending: Array<{
    obj_guid: string;
    name: string;
    slot_type: number;
    timespec_val: Date;
  }> = [];

  for (const row of rows) {
    // A `trans-date-due` of the WRONG slot type is data no reader accepts and
    // no writer of ours produces. Leave it alone and count it.
    if (Number(row.other_type_slots) > 0) {
      result.wrongSlotType++;
      continue;
    }
    result.candidates++;
    if (!row.post_date) {
      result.skippedNoPostDate++;
      continue;
    }
    const term: BillTermSpec | null = row.term_type === null
      ? null
      : { type: row.term_type, duedays: row.term_duedays, cutoff: row.term_cutoff };
    pending.push({
      obj_guid: row.post_txn,
      name: 'trans-date-due',
      slot_type: SLOT_TIMESPEC,
      timespec_val: computeLegacyInvoiceDueDate({
        invoiceGuid: row.invoice_guid,
        postTxnGuid: row.post_txn,
        postDate: row.post_date,
        term,
      }),
    });
  }

  for (let offset = 0; offset < pending.length; offset += WRITE_CHUNK) {
    const created = await db.slots.createMany({
      data: pending.slice(offset, offset + WRITE_CHUNK),
    });
    result.written += created.count;
  }

  return result;
}
