/**
 * Recurring Invoices — scheduled generation of AR/AP documents.
 *
 * A recurring definition stores a frozen `createInvoice` template (entries,
 * notes, terms, currency) plus a recurrence pattern from `src/lib/recurrence.ts`
 * (period_type + mult anchored at start_date). `runDueRecurringInvoices`
 * generates one invoice per due occurrence, optionally auto-posting it, and
 * pushes a notification per generated document.
 *
 * The backing table is NOT part of the Prisma schema (the GnuCash DB rejects
 * `prisma db push`), so it is created lazily via raw SQL under an advisory
 * lock — the same pattern as `src/lib/notifications.ts`. Do NOT add this
 * table to `db-init.ts`.
 *
 * Concurrency / idempotency: each occurrence is CLAIMED first with an atomic
 * `UPDATE ... WHERE next_date = <expected> RETURNING id` before the invoice is
 * created. Two overlapping runners can never generate the same occurrence
 * twice; the trade-off is that a failure after the claim skips that
 * occurrence (an error notification is emitted instead).
 *
 * Structure mirrors `business-reports.ts`: PURE date/dedupe helpers exported
 * for unit tests + thin DB loaders.
 */

import prisma from '@/lib/prisma';
import { computeNextOccurrences, type RecurrencePattern } from '@/lib/recurrence';
import { createNotification, ensureNotificationsTable } from '@/lib/notifications';
import {
  createInvoice,
  postInvoice,
  type InvoiceEntryInput,
} from './invoice-engine';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type RecurringOwnerType = 'customer' | 'vendor';

/** recurrence.ts period types supported for recurring documents. */
export const RECURRING_PERIOD_TYPES = ['daily', 'weekly', 'month', 'year'] as const;
export type RecurringPeriodType = (typeof RECURRING_PERIOD_TYPES)[number];

/** Frozen `createInvoice` body (owner + dates supplied at run time). */
export interface RecurringTemplate {
  entries: InvoiceEntryInput[];
  notes?: string;
  billingId?: string;
  termsGuid?: string | null;
  currencyGuid?: string;
}

export interface RecurringInvoiceDef {
  id: number;
  bookGuid: string;
  name: string;
  ownerType: RecurringOwnerType;
  ownerGuid: string;
  ownerName: string | null;
  template: RecurringTemplate;
  periodType: RecurringPeriodType;
  mult: number;
  /** ISO dates (YYYY-MM-DD). */
  startDate: string;
  lastRun: string | null;
  nextDate: string;
  autoPost: boolean;
  active: boolean;
  createdAt: string;
}

export interface CreateRecurringInput {
  name: string;
  ownerType: RecurringOwnerType;
  ownerGuid: string;
  template: RecurringTemplate;
  periodType: RecurringPeriodType;
  mult: number;
  startDate: string;
  autoPost?: boolean;
  active?: boolean;
}

export interface UpdateRecurringInput {
  name?: string;
  template?: RecurringTemplate;
  periodType?: RecurringPeriodType;
  mult?: number;
  startDate?: string;
  nextDate?: string;
  autoPost?: boolean;
  active?: boolean;
}

export interface RecurringRunOccurrence {
  date: string;
  invoiceGuid: string;
  invoiceId: string;
  posted: boolean;
}

export interface RecurringRunDefResult {
  defId: number;
  name: string;
  occurrences: RecurringRunOccurrence[];
  /** First error hit for this definition (later occurrences are skipped). */
  error?: string;
}

export interface RecurringRunResult {
  generated: number;
  results: RecurringRunDefResult[];
}

/** Caller-fixable input problem — API routes map to HTTP 400. */
export class RecurringInvoiceValidationError extends Error {}
/** Missing definition — HTTP 404. */
export class RecurringInvoiceNotFoundError extends Error {}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested, DB-free)                                  */
/* ------------------------------------------------------------------ */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO date as a LOCAL date (recurrence.ts works in local time). */
export function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Format a local Date back to ISO YYYY-MM-DD. */
export function toIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Next occurrence STRICTLY AFTER `afterIso`, anchored at `startIso`.
 *
 * Anchoring at start_date (rather than stepping from the last occurrence)
 * keeps the day-of-month stable across short months: monthly from Jan 31
 * yields Feb 28 then Mar 31 — no permanent drift to the 28th.
 */
export function nextOccurrenceIso(
  periodType: RecurringPeriodType,
  mult: number,
  startIso: string,
  afterIso: string,
): string {
  const pattern: RecurrencePattern = {
    periodType,
    mult,
    periodStart: parseIsoLocal(startIso),
    weekendAdjust: 'none',
  };
  const [next] = computeNextOccurrences(pattern, null, null, null, 1, parseIsoLocal(afterIso));
  if (!next) {
    throw new RecurringInvoiceValidationError(
      `Could not compute the next occurrence for period '${periodType}' x${mult}`,
    );
  }
  return toIsoLocal(next);
}

/**
 * Dedupe key for the notification emitted per generated occurrence:
 * `def:{definition id}:{occurrence date}`.
 */
export function recurringSourceId(defId: number, occurrenceIso: string): string {
  return `def:${defId}:${occurrenceIso}`;
}

export function isRecurringPeriodType(v: unknown): v is RecurringPeriodType {
  return typeof v === 'string' && (RECURRING_PERIOD_TYPES as readonly string[]).includes(v);
}

/** Validate a create payload; throws RecurringInvoiceValidationError. */
export function validateRecurringInput(input: CreateRecurringInput): void {
  if (!input.name || !input.name.trim()) {
    throw new RecurringInvoiceValidationError('name is required');
  }
  if (input.ownerType !== 'customer' && input.ownerType !== 'vendor') {
    throw new RecurringInvoiceValidationError("ownerType must be 'customer' or 'vendor'");
  }
  if (!input.ownerGuid || input.ownerGuid.length !== 32) {
    throw new RecurringInvoiceValidationError('ownerGuid must be a 32-char GUID');
  }
  if (!isRecurringPeriodType(input.periodType)) {
    throw new RecurringInvoiceValidationError(
      `periodType must be one of: ${RECURRING_PERIOD_TYPES.join(', ')}`,
    );
  }
  if (!Number.isInteger(input.mult) || input.mult < 1 || input.mult > 120) {
    throw new RecurringInvoiceValidationError('mult must be an integer between 1 and 120');
  }
  if (!ISO_DATE_RE.test(input.startDate ?? '')) {
    throw new RecurringInvoiceValidationError('startDate must be YYYY-MM-DD');
  }
  const entries = input.template?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RecurringInvoiceValidationError('template.entries must be a non-empty array');
  }
  for (const e of entries) {
    if (!e.accountGuid) {
      throw new RecurringInvoiceValidationError('Every template entry needs an accountGuid');
    }
    if (typeof e.quantity !== 'number' || !isFinite(e.quantity)) {
      throw new RecurringInvoiceValidationError('Template entry quantity must be a finite number');
    }
    if (typeof e.price !== 'number' || !isFinite(e.price)) {
      throw new RecurringInvoiceValidationError('Template entry price must be a finite number');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Lazy table creation                                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureRecurringInvoicesTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_recurring_invoices_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_recurring_invoices (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name TEXT NOT NULL,
            owner_type VARCHAR(10) NOT NULL,
            owner_guid VARCHAR(32) NOT NULL,
            template JSONB NOT NULL,
            period_type VARCHAR(16) NOT NULL,
            mult INTEGER NOT NULL DEFAULT 1,
            start_date DATE NOT NULL,
            last_run DATE,
            next_date DATE NOT NULL,
            auto_post BOOLEAN NOT NULL DEFAULT false,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_recurring_invoices_book_due
            ON gnucash_web_recurring_invoices(book_guid, active, next_date);
        END $$;
      `);
    })();
  }
  return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                          */
/* ------------------------------------------------------------------ */

interface DefRow {
  id: number;
  book_guid: string;
  name: string;
  owner_type: string;
  owner_guid: string;
  template: unknown;
  period_type: string;
  mult: number;
  start_date: string;
  last_run: string | null;
  next_date: string;
  auto_post: boolean;
  active: boolean;
  created_at: Date;
}

const DEF_SELECT = `
  id, book_guid, name, owner_type, owner_guid, template, period_type, mult,
  to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(last_run, 'YYYY-MM-DD') AS last_run,
  to_char(next_date, 'YYYY-MM-DD') AS next_date,
  auto_post, active, created_at
`;

function rowToDef(row: DefRow, ownerName: string | null = null): RecurringInvoiceDef {
  const template = (typeof row.template === 'string'
    ? JSON.parse(row.template)
    : row.template) as RecurringTemplate;
  return {
    id: row.id,
    bookGuid: row.book_guid,
    name: row.name,
    ownerType: row.owner_type === 'vendor' ? 'vendor' : 'customer',
    ownerGuid: row.owner_guid,
    ownerName,
    template,
    periodType: isRecurringPeriodType(row.period_type) ? row.period_type : 'month',
    mult: row.mult,
    startDate: row.start_date,
    lastRun: row.last_run,
    nextDate: row.next_date,
    autoPost: row.auto_post,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

async function resolveOwnerNames(
  rows: DefRow[],
): Promise<Map<string, string>> {
  const customerGuids = rows.filter((r) => r.owner_type === 'customer').map((r) => r.owner_guid);
  const vendorGuids = rows.filter((r) => r.owner_type === 'vendor').map((r) => r.owner_guid);
  const names = new Map<string, string>();
  if (customerGuids.length > 0) {
    const customers = await prisma.customers.findMany({
      where: { guid: { in: customerGuids } },
      select: { guid: true, name: true },
    });
    for (const c of customers) names.set(`customer:${c.guid}`, c.name);
  }
  if (vendorGuids.length > 0) {
    const vendors = await prisma.vendors.findMany({
      where: { guid: { in: vendorGuids } },
      select: { guid: true, name: true },
    });
    for (const v of vendors) names.set(`vendor:${v.guid}`, v.name);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export async function listRecurringInvoices(bookGuid: string): Promise<RecurringInvoiceDef[]> {
  await ensureRecurringInvoicesTable();
  const rows = await prisma.$queryRawUnsafe<DefRow[]>(
    `SELECT ${DEF_SELECT} FROM gnucash_web_recurring_invoices
     WHERE book_guid = $1
     ORDER BY active DESC, next_date ASC, id ASC`,
    bookGuid,
  );
  const names = await resolveOwnerNames(rows);
  return rows.map((r) => rowToDef(r, names.get(`${r.owner_type}:${r.owner_guid}`) ?? null));
}

export async function getRecurringInvoice(
  bookGuid: string,
  id: number,
): Promise<RecurringInvoiceDef> {
  await ensureRecurringInvoicesTable();
  const rows = await prisma.$queryRawUnsafe<DefRow[]>(
    `SELECT ${DEF_SELECT} FROM gnucash_web_recurring_invoices
     WHERE book_guid = $1 AND id = $2`,
    bookGuid,
    id,
  );
  if (rows.length === 0) {
    throw new RecurringInvoiceNotFoundError(`Recurring invoice not found: ${id}`);
  }
  const names = await resolveOwnerNames(rows);
  return rowToDef(rows[0], names.get(`${rows[0].owner_type}:${rows[0].owner_guid}`) ?? null);
}

export async function createRecurringInvoice(
  bookGuid: string,
  input: CreateRecurringInput,
): Promise<RecurringInvoiceDef> {
  validateRecurringInput(input);

  // Owner must exist (name check also gives friendlier errors than a run failure)
  if (input.ownerType === 'customer') {
    const owner = await prisma.customers.findUnique({ where: { guid: input.ownerGuid }, select: { guid: true } });
    if (!owner) throw new RecurringInvoiceValidationError(`Customer not found: ${input.ownerGuid}`);
  } else {
    const owner = await prisma.vendors.findUnique({ where: { guid: input.ownerGuid }, select: { guid: true } });
    if (!owner) throw new RecurringInvoiceValidationError(`Vendor not found: ${input.ownerGuid}`);
  }

  await ensureRecurringInvoicesTable();
  const rows = await prisma.$queryRaw<DefRow[]>`
    INSERT INTO gnucash_web_recurring_invoices
      (book_guid, name, owner_type, owner_guid, template, period_type, mult,
       start_date, next_date, auto_post, active)
    VALUES
      (${bookGuid}, ${input.name.trim()}, ${input.ownerType}, ${input.ownerGuid},
       ${JSON.stringify(input.template)}::jsonb, ${input.periodType}, ${input.mult},
       ${input.startDate}::date, ${input.startDate}::date,
       ${input.autoPost ?? false}, ${input.active ?? true})
    RETURNING
      id, book_guid, name, owner_type, owner_guid, template, period_type, mult,
      to_char(start_date, 'YYYY-MM-DD') AS start_date,
      to_char(last_run, 'YYYY-MM-DD') AS last_run,
      to_char(next_date, 'YYYY-MM-DD') AS next_date,
      auto_post, active, created_at
  `;
  return rowToDef(rows[0]);
}

export async function updateRecurringInvoice(
  bookGuid: string,
  id: number,
  input: UpdateRecurringInput,
): Promise<RecurringInvoiceDef> {
  const existing = await getRecurringInvoice(bookGuid, id);

  const merged: CreateRecurringInput = {
    name: input.name ?? existing.name,
    ownerType: existing.ownerType,
    ownerGuid: existing.ownerGuid,
    template: input.template ?? existing.template,
    periodType: input.periodType ?? existing.periodType,
    mult: input.mult ?? existing.mult,
    startDate: input.startDate ?? existing.startDate,
    autoPost: input.autoPost ?? existing.autoPost,
    active: input.active ?? existing.active,
  };
  validateRecurringInput(merged);

  const nextDate = input.nextDate ?? existing.nextDate;
  if (!ISO_DATE_RE.test(nextDate)) {
    throw new RecurringInvoiceValidationError('nextDate must be YYYY-MM-DD');
  }

  const rows = await prisma.$queryRaw<DefRow[]>`
    UPDATE gnucash_web_recurring_invoices
    SET name = ${merged.name.trim()},
        template = ${JSON.stringify(merged.template)}::jsonb,
        period_type = ${merged.periodType},
        mult = ${merged.mult},
        start_date = ${merged.startDate}::date,
        next_date = ${nextDate}::date,
        auto_post = ${merged.autoPost},
        active = ${merged.active}
    WHERE book_guid = ${bookGuid} AND id = ${id}
    RETURNING
      id, book_guid, name, owner_type, owner_guid, template, period_type, mult,
      to_char(start_date, 'YYYY-MM-DD') AS start_date,
      to_char(last_run, 'YYYY-MM-DD') AS last_run,
      to_char(next_date, 'YYYY-MM-DD') AS next_date,
      auto_post, active, created_at
  `;
  if (rows.length === 0) {
    throw new RecurringInvoiceNotFoundError(`Recurring invoice not found: ${id}`);
  }
  return rowToDef(rows[0], existing.ownerName);
}

export async function deleteRecurringInvoice(bookGuid: string, id: number): Promise<void> {
  await ensureRecurringInvoicesTable();
  const deleted = await prisma.$executeRaw`
    DELETE FROM gnucash_web_recurring_invoices
    WHERE book_guid = ${bookGuid} AND id = ${id}
  `;
  if (deleted === 0) {
    throw new RecurringInvoiceNotFoundError(`Recurring invoice not found: ${id}`);
  }
}

/* ------------------------------------------------------------------ */
/* Runner                                                               */
/* ------------------------------------------------------------------ */

/** Safety cap on catch-up occurrences per definition in a single run. */
const MAX_CATCHUP_PER_DEF = 12;

async function notificationExists(sourceId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM gnucash_web_notifications
    WHERE source = 'recurring-invoice' AND source_id = ${sourceId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Generate all due occurrences (next_date <= asOf) for the book's active
 * recurring definitions.
 *
 *   - One invoice per occurrence via `createInvoice` (dateOpened = occurrence
 *     date); when auto_post is set, `postInvoice` with postDate = occurrence.
 *   - next_date advances via the recurrence engine (anchored at start_date);
 *     last_run records the occurrence just generated.
 *   - Per-definition try/catch: one broken template never stops the others.
 *   - A notification is created per generated invoice with
 *     source='recurring-invoice' and sourceId `def:{id}:{date}` (deduped).
 *
 * Safe to call from background jobs (no session dependency): the book root
 * for auto-posting is resolved from `bookGuid` directly.
 */
export async function runDueRecurringInvoices(
  bookGuid: string,
  options: { userId: number; asOf?: string; defId?: number },
): Promise<RecurringRunResult> {
  await ensureRecurringInvoicesTable();
  await ensureNotificationsTable();

  const asOf = options.asOf && ISO_DATE_RE.test(options.asOf)
    ? options.asOf
    : toIsoLocal(new Date());

  const params: unknown[] = [bookGuid, asOf];
  let defFilter = '';
  if (options.defId !== undefined) {
    params.push(options.defId);
    defFilter = ' AND id = $3';
  }
  const dueRows = await prisma.$queryRawUnsafe<DefRow[]>(
    `SELECT ${DEF_SELECT} FROM gnucash_web_recurring_invoices
     WHERE book_guid = $1 AND active = true AND next_date <= $2::date${defFilter}
     ORDER BY next_date ASC, id ASC`,
    ...params,
  );
  if (dueRows.length === 0) return { generated: 0, results: [] };

  // Book root for auto-posting (A/R–A/P discovery scope). Resolved from the
  // book guid — deliberately NOT session-based, so background syncs work.
  let bookRootGuid: string | null = null;
  const needsRoot = dueRows.some((r) => r.auto_post);
  if (needsRoot) {
    const book = await prisma.books.findUnique({
      where: { guid: bookGuid },
      select: { root_account_guid: true },
    });
    bookRootGuid = book?.root_account_guid ?? null;
  }

  const results: RecurringRunDefResult[] = [];
  let generated = 0;

  for (const row of dueRows) {
    const def = rowToDef(row);
    const result: RecurringRunDefResult = { defId: def.id, name: def.name, occurrences: [] };
    results.push(result);

    try {
      let occurrence = def.nextDate;
      for (let i = 0; i < MAX_CATCHUP_PER_DEF && occurrence <= asOf; i++) {
        const next = nextOccurrenceIso(def.periodType, def.mult, def.startDate, occurrence);

        // Atomic claim: advance next_date only if nobody else already has.
        // A concurrent runner that raced us gets 0 rows and stops cleanly.
        const claimed = await prisma.$queryRaw<Array<{ id: number }>>`
          UPDATE gnucash_web_recurring_invoices
          SET next_date = ${next}::date, last_run = ${occurrence}::date
          WHERE id = ${def.id}
            AND to_char(next_date, 'YYYY-MM-DD') = ${occurrence}
          RETURNING id
        `;
        if (claimed.length === 0) break;

        const invoice = await createInvoice({
          ownerType: def.ownerType,
          ownerGuid: def.ownerGuid,
          dateOpened: occurrence,
          notes: def.template.notes,
          billingId: def.template.billingId,
          termsGuid: def.template.termsGuid ?? undefined,
          currencyGuid: def.template.currencyGuid,
          entries: def.template.entries,
          bookGuid,
        });

        let posted = false;
        if (def.autoPost && bookRootGuid) {
          await postInvoice(invoice.guid, { postDate: occurrence, bookRootGuid });
          posted = true;
        }

        result.occurrences.push({
          date: occurrence,
          invoiceGuid: invoice.guid,
          invoiceId: invoice.id,
          posted,
        });
        generated++;

        // Notification (deduped on sourceId)
        const sourceId = recurringSourceId(def.id, occurrence);
        if (!(await notificationExists(sourceId))) {
          const kindLabel = def.ownerType === 'customer' ? 'Invoice' : 'Bill';
          await createNotification({
            userId: options.userId,
            bookGuid,
            type: 'recurring_invoice',
            severity: 'info',
            title: `Recurring: ${def.name}`,
            message: `${kindLabel} ${invoice.id} generated for ${occurrence}${posted ? ' and posted' : ''}`,
            href: `/business/invoices/${invoice.guid}`,
            source: 'recurring-invoice',
            sourceId,
          });
        }

        occurrence = next;
      }
    } catch (err) {
      // One failing definition must not stop the others. The occurrence was
      // already claimed (next_date advanced) — surface the failure loudly.
      const message = err instanceof Error ? err.message : String(err);
      result.error = message;
      console.warn(`Recurring invoice def ${def.id} (${def.name}) failed:`, err);
      try {
        await createNotification({
          userId: options.userId,
          bookGuid,
          type: 'recurring_invoice',
          severity: 'error',
          title: `Recurring invoice failed: ${def.name}`,
          message,
          href: '/business/recurring',
          source: 'recurring-invoice',
          sourceId: `def:${def.id}:error:${Date.now()}`,
        });
      } catch {
        /* notification failure must never fail the run */
      }
    }
  }

  return { generated, results };
}
