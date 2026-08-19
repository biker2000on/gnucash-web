/**
 * Legacy `trans-date-due` backfill — pure math + the "only writes when the
 * slot is missing" guard, over a fake prisma.
 *
 * The bug: an invoice posted before postInvoice persisted `trans-date-due` has
 * no slot, so resolveAgingDueDate returns dueDateInferred and the dunning job
 * skips it forever. These tests pin that the backfill recomputes the due date
 * the way posting would have, and that it writes NOTHING for a transaction
 * that already has the slot (so re-running it is a no-op).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  backfillInvoiceDueDateSlots,
  computeLegacyInvoiceDueDate,
  SLOT_TIMESPEC,
  type DueDateBackfillDb,
} from '../invoice-due-date-backfill';
import { computeDueDate } from '../invoice-totals';
import { resolveAgingDueDate } from '../business-reports';
import { shouldSkipDunningForInferredDueDate } from '../dunning';

const POST_DATE = new Date(Date.UTC(2026, 5, 1, 12, 0, 0)); // 2026-06-01 noon

interface FakeRow {
  invoice_guid: string;
  post_txn: string;
  post_date: Date | null;
  term_type: string | null;
  term_duedays: number | null;
  term_cutoff: number | null;
  other_type_slots: number;
}

/**
 * Fake prisma standing in for the real one. `rows` is what the candidate query
 * returns — i.e. exactly the posted invoices whose posting transaction has no
 * timespec `trans-date-due` slot. Everything the backfill writes lands in
 * `created`.
 */
function fakeDb(rows: FakeRow[]) {
  const created: Array<{ obj_guid: string; name: string; slot_type: number; timespec_val: Date }> = [];
  let queries = 0;
  const db: DueDateBackfillDb = {
    $queryRaw: (async () => {
      queries++;
      return rows;
    }) as DueDateBackfillDb['$queryRaw'],
    slots: {
      createMany: async ({ data }) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  return { db, created, queryCount: () => queries };
}

const row = (over: Partial<FakeRow> = {}): FakeRow => ({
  invoice_guid: 'inv-1',
  post_txn: 'txn-1',
  post_date: POST_DATE,
  term_type: 'GNC_TERM_TYPE_DAYS',
  term_duedays: 30,
  term_cutoff: null,
  other_type_slots: 0,
  ...over,
});

describe('computeLegacyInvoiceDueDate', () => {
  const legacy = (term: { type: string; duedays: number | null; cutoff: number | null } | null) => ({
    invoiceGuid: 'inv-1',
    postTxnGuid: 'txn-1',
    postDate: POST_DATE,
    term,
  });

  it('applies Net-30 bill terms to the post date', () => {
    const due = computeLegacyInvoiceDueDate(
      legacy({ type: 'GNC_TERM_TYPE_DAYS', duedays: 30, cutoff: null }),
    );
    expect(due.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('applies PROXIMO terms the same way posting does', () => {
    // Posted Jun 1 with a cutoff of 10 -> due the 15th of the NEXT month.
    const term = { type: 'GNC_TERM_TYPE_PROXIMO', duedays: 15, cutoff: 10 };
    const due = computeLegacyInvoiceDueDate(legacy(term));
    expect(due.toISOString().slice(0, 10)).toBe('2026-07-15');
    // And it is literally the post path's own function, not a reimplementation.
    expect(due.getTime()).toBe(computeDueDate(POST_DATE, term).getTime());
  });

  it('falls back to the post date when the invoice has no terms', () => {
    expect(computeLegacyInvoiceDueDate(legacy(null)).getTime()).toBe(POST_DATE.getTime());
  });

  it('falls back to the post date for a term with no duedays', () => {
    const due = computeLegacyInvoiceDueDate(
      legacy({ type: 'GNC_TERM_TYPE_DAYS', duedays: null, cutoff: null }),
    );
    expect(due.getTime()).toBe(POST_DATE.getTime());
  });
});

describe('backfillInvoiceDueDateSlots', () => {
  it('writes one timespec slot per legacy invoice, on the POSTING transaction', async () => {
    const { db, created } = fakeDb([
      row(),
      row({ invoice_guid: 'inv-2', post_txn: 'txn-2', term_duedays: 15 }),
    ]);

    const result = await backfillInvoiceDueDateSlots(db);

    expect(result).toMatchObject({ candidates: 2, written: 2, skippedNoPostDate: 0, wrongSlotType: 0 });
    expect(created).toEqual([
      { obj_guid: 'txn-1', name: 'trans-date-due', slot_type: SLOT_TIMESPEC, timespec_val: new Date('2026-07-01T12:00:00.000Z') },
      { obj_guid: 'txn-2', name: 'trans-date-due', slot_type: SLOT_TIMESPEC, timespec_val: new Date('2026-06-16T12:00:00.000Z') },
    ]);
  });

  it('writes NOTHING when no invoice is missing the slot (the re-run case)', async () => {
    // The candidate query excludes any transaction that already has a timespec
    // trans-date-due slot, so a second run sees an empty result set.
    const { db, created } = fakeDb([]);

    const result = await backfillInvoiceDueDateSlots(db);

    expect(result).toEqual({ candidates: 0, written: 0, skippedNoPostDate: 0, wrongSlotType: 0 });
    expect(created).toHaveLength(0);
  });

  it('leaves a transaction carrying a NON-timespec trans-date-due slot alone', async () => {
    const { db, created } = fakeDb([row({ other_type_slots: 1 })]);

    const result = await backfillInvoiceDueDateSlots(db);

    expect(result.wrongSlotType).toBe(1);
    expect(result.candidates).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('skips a posting transaction with no post_date rather than inventing a due date', async () => {
    const { db, created } = fakeDb([row({ post_date: null })]);

    const result = await backfillInvoiceDueDateSlots(db);

    expect(result).toMatchObject({ candidates: 1, written: 0, skippedNoPostDate: 1 });
    expect(created).toHaveLength(0);
  });

  it('chunks large write sets instead of one giant statement', async () => {
    const many = Array.from({ length: 1_200 }, (_, i) =>
      row({ invoice_guid: `inv-${i}`, post_txn: `txn-${i}` }),
    );
    const { db, created } = fakeDb(many);
    const createMany = vi.spyOn(db.slots, 'createMany');

    const result = await backfillInvoiceDueDateSlots(db);

    expect(result.written).toBe(1_200);
    expect(created).toHaveLength(1_200);
    expect(createMany).toHaveBeenCalledTimes(3); // 500 + 500 + 200
  });

  it('reads the candidates in ONE query', async () => {
    const { db, queryCount } = fakeDb([row(), row({ invoice_guid: 'inv-2', post_txn: 'txn-2' })]);
    await backfillInvoiceDueDateSlots(db);
    expect(queryCount()).toBe(1);
  });
});

describe('the backfilled slot is what unblocks dunning', () => {
  it('turns an inferred (undunnable) due date into a stored one', async () => {
    // BEFORE: no slot -> resolveAgingDueDate infers from the post date and the
    // dunning job skips the invoice outright.
    const before = resolveAgingDueDate({ datePosted: POST_DATE, dueDate: null });
    expect(before.dueDateInferred).toBe(true);
    expect(shouldSkipDunningForInferredDueDate(before.dueDateInferred)).toBe(true);

    // AFTER: the slot the backfill writes is a real, terms-derived due date.
    const { db, created } = fakeDb([row()]);
    await backfillInvoiceDueDateSlots(db);

    const after = resolveAgingDueDate({
      datePosted: POST_DATE,
      dueDate: created[0].timespec_val,
    });
    expect(after.dueDateInferred).toBe(false);
    expect(shouldSkipDunningForInferredDueDate(after.dueDateInferred)).toBe(false);
    expect(after.dueDate?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });
});
