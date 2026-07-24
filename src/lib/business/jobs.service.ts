/**
 * Jobs service — extends the base job CRUD (src/lib/services/business.service.ts,
 * imported READ-ONLY) with:
 *
 *   - JOB RATE: GnuCash stores a job's default rate as a top-level KVP slot
 *     on the job (name 'job-rate', slot_type 3 = NUMERIC), not as a jobs
 *     column. We read/write that slot with denom 1,000,000 (price precision,
 *     matching the invoice engine's entry prices).
 *   - PARTIAL UPDATE (PATCH semantics): merge the incoming fields onto the
 *     existing row so callers can flip `active` or set `rate` alone.
 *   - JOB REPORT: per-job rollup of the documents that reference the job
 *     (invoices owner_type=3 → this job), with posted totals, paid and
 *     balance from the GnuCash lot linkage, plus draft entry totals.
 *
 * Do not add functions here that belong in business.service.ts — that file
 * is intentionally not modified by this module.
 */

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { fromDecimal, toDecimalNumber } from '@/lib/gnucash';
import {
  listJobs,
  getJob,
  createJob,
  updateJob,
  BusinessValidationError,
  type JobInput,
  type JobListOptions,
} from '@/lib/services/business.service';
import type { JobDTO } from '@/lib/business-types';
import { OWNER_TYPE_CUSTOMER, OWNER_TYPE_JOB } from './business-reports';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { logAudit } from '@/lib/services/audit.service';

/** KVP slot GnuCash uses for the job's default rate (gncJob.c GNC_JOB_RATE). */
export const JOB_RATE_SLOT = 'job-rate';
/** KvpValue::Type NUMERIC. */
const SLOT_NUMERIC = 3;
/** Rate precision — matches the engine's entry-price denominator. */
const RATE_DENOM = 1_000_000;

export interface JobExDTO extends JobDTO {
  /** Default rate from the 'job-rate' slot; null when unset. */
  rate: number | null;
}

/* ------------------------------------------------------------------ */
/* Rate slot                                                            */
/* ------------------------------------------------------------------ */

async function getJobRates(jobGuids: string[]): Promise<Map<string, number>> {
  if (jobGuids.length === 0) return new Map();
  const rows = await prisma.slots.findMany({
    where: { obj_guid: { in: jobGuids }, name: JOB_RATE_SLOT },
    select: { obj_guid: true, numeric_val_num: true, numeric_val_denom: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.obj_guid, toDecimalNumber(r.numeric_val_num, r.numeric_val_denom));
  }
  return map;
}

/** Set (rate > 0), or clear (null/0), the job's 'job-rate' numeric slot. */
export async function setJobRate(jobGuid: string, rate: number | null): Promise<void> {
  await prisma.slots.deleteMany({ where: { obj_guid: jobGuid, name: JOB_RATE_SLOT } });
  if (rate != null && rate > 0) {
    const frac = fromDecimal(rate, RATE_DENOM);
    await prisma.slots.create({
      data: {
        obj_guid: jobGuid,
        name: JOB_RATE_SLOT,
        slot_type: SLOT_NUMERIC,
        numeric_val_num: frac.num,
        numeric_val_denom: frac.denom,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Reads / CRUD                                                         */
/* ------------------------------------------------------------------ */

export async function listJobsEx(options: JobListOptions = {}): Promise<JobExDTO[]> {
  const jobs = await listJobs(options);
  const rates = await getJobRates(jobs.map((j) => j.guid));
  return jobs.map((j) => ({ ...j, rate: rates.get(j.guid) ?? null }));
}

export async function getJobEx(guid: string): Promise<JobExDTO | null> {
  const job = await getJob(guid);
  if (!job) return null;
  const rates = await getJobRates([guid]);
  return { ...job, rate: rates.get(guid) ?? null };
}

export const jobExInputSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(2048),
  reference: z.string().max(2048).default(''),
  active: z.boolean().default(true),
  ownerType: z.enum(['customer', 'vendor']),
  ownerGuid: z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-char hex guid'),
  rate: z.number().min(0).nullish(),
});
export type JobExInput = z.infer<typeof jobExInputSchema>;

export async function createJobEx(input: JobExInput): Promise<JobExDTO> {
  const job = await createJob(input as JobInput);
  if (input.rate !== undefined) await setJobRate(job.guid, input.rate ?? null);
  return (await getJobEx(job.guid))!;
}

/** PATCH schema: every field optional; `rate: null` clears the slot. */
export const jobPatchSchema = z.object({
  name: z.string().trim().min(1).max(2048).optional(),
  reference: z.string().max(2048).optional(),
  active: z.boolean().optional(),
  ownerType: z.enum(['customer', 'vendor']).optional(),
  ownerGuid: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  rate: z.number().min(0).nullish(),
});
export type JobPatch = z.infer<typeof jobPatchSchema>;

/**
 * Partial update: merge the patch onto the existing job, then apply via the
 * base full-update (owner re-validated there). Rate handled separately.
 */
export async function updateJobPartial(guid: string, patch: JobPatch): Promise<JobExDTO | null> {
  const existing = await getJob(guid);
  if (!existing) return null;

  if ((patch.ownerType && !patch.ownerGuid) || (!patch.ownerType && patch.ownerGuid)) {
    // Allow changing the owner only as a pair unless the existing side matches.
    if (!existing.ownerType || !existing.ownerGuid) {
      throw new BusinessValidationError('ownerType and ownerGuid must be provided together');
    }
  }

  const merged: JobInput = {
    name: patch.name ?? existing.name,
    reference: patch.reference ?? existing.reference,
    active: patch.active ?? existing.active,
    ownerType: patch.ownerType ?? existing.ownerType ?? 'customer',
    ownerGuid: patch.ownerGuid ?? existing.ownerGuid ?? '',
  };
  const updated = await updateJob(guid, merged);
  if (!updated) return null;

  if (patch.rate !== undefined) await setJobRate(guid, patch.rate ?? null);
  return getJobEx(guid);
}

/* ------------------------------------------------------------------ */
/* Job report — pure builder                                            */
/* ------------------------------------------------------------------ */

/** Raw per-document row from the loader (DB-free for tests). */
export interface RawJobDocRow {
  guid: string;
  id: string;
  /** The owning job's owner type (2 customer → invoices, 4 vendor → bills). */
  jobOwnerType: number;
  posted: boolean;
  dateOpened: string | null;
  datePosted: string | null;
  /** Raw A/R–A/P post-split sum (invoice +total, bill -total); null for drafts. */
  postTotal: number | null;
  /** Raw lot-split sum (invoice + = unpaid, bill - = unpaid); null for drafts. */
  lotBalance: number | null;
  /** Sum of entry quantity x price (no tax/discount) — used for draft totals. */
  entryTotal: number | null;
  currency: string;
}

export interface JobReportDocument {
  guid: string;
  id: string;
  kind: 'invoice' | 'bill';
  posted: boolean;
  dateOpened: string | null;
  datePosted: string | null;
  /** Posted document total (sign-normalized positive); drafts: entry sum. */
  total: number;
  paid: number;
  due: number;
  currency: string;
}

export interface JobReport {
  documents: JobReportDocument[];
  totals: {
    /** Sum of posted document totals. */
    invoiced: number;
    paid: number;
    due: number;
    /** Sum of unposted (draft) entry totals — quantity x price, no tax. */
    draftTotal: number;
  };
  postedCount: number;
  draftCount: number;
}

export interface JobCostLink {
  id: number;
  sourceType: 'manual' | 'transaction' | 'voucher' | 'material';
  sourceId: string | null;
  description: string;
  costDate: string;
  amount: number;
  billable: boolean;
  invoicedInvoiceGuid: string | null;
}

export interface JobProfitability {
  revenue: number;
  collected: number;
  accountsReceivable: number;
  directCosts: number;
  laborCost: number;
  grossProfit: number;
  marginPercent: number | null;
  trackedHours: number;
  unbilledHours: number;
  unbilledTimeValue: number;
  unbilledExpenseValue: number;
  overdueCollections: number;
  costLinks: JobCostLink[];
  taggedExpenseTotal: number;
}

export interface JobProfitabilityReport extends JobReport {
  profitability: JobProfitability;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0
}

/**
 * Roll up a job's documents. Pure. Sign conventions follow the engine:
 * invoice post/lot splits are positive, bill splits negative — both are
 * normalized so totals read positive. Draft documents contribute entry sums
 * (quantity x price, no tax/discount) to `draftTotal` only.
 */
export function buildJobReport(rows: ReadonlyArray<RawJobDocRow>): JobReport {
  const documents: JobReportDocument[] = [];
  let invoiced = 0;
  let paid = 0;
  let due = 0;
  let draftTotal = 0;
  let postedCount = 0;
  let draftCount = 0;

  for (const row of rows) {
    const kind = row.jobOwnerType === OWNER_TYPE_CUSTOMER ? 'invoice' : 'bill';
    const sign = kind === 'invoice' ? 1 : -1;

    if (row.posted) {
      const total = round2(sign * (row.postTotal ?? 0));
      const docDue = round2(sign * (row.lotBalance ?? 0));
      const docPaid = round2(total - docDue);
      invoiced = round2(invoiced + total);
      paid = round2(paid + docPaid);
      due = round2(due + docDue);
      postedCount++;
      documents.push({
        guid: row.guid, id: row.id, kind, posted: true,
        dateOpened: row.dateOpened, datePosted: row.datePosted,
        total, paid: docPaid, due: docDue, currency: row.currency,
      });
    } else {
      const total = round2(row.entryTotal ?? 0);
      draftTotal = round2(draftTotal + total);
      draftCount++;
      documents.push({
        guid: row.guid, id: row.id, kind, posted: false,
        dateOpened: row.dateOpened, datePosted: null,
        total, paid: 0, due: 0, currency: row.currency,
      });
    }
  }

  // Most recent first (posted date, else opened date).
  documents.sort((a, b) =>
    (b.datePosted ?? b.dateOpened ?? '').localeCompare(a.datePosted ?? a.dateOpened ?? ''));

  return {
    documents,
    totals: { invoiced, paid, due, draftTotal },
    postedCount,
    draftCount,
  };
}

/* ------------------------------------------------------------------ */
/* Job report — SQL loader                                              */
/* ------------------------------------------------------------------ */

interface JobDocDbRow {
  guid: string;
  id: string;
  job_owner_type: number | null;
  posted: boolean;
  date_opened: Date | null;
  date_posted: Date | null;
  post_total: number | null;
  lot_balance: number | null;
  entry_total: number | null;
  currency: string | null;
}

/**
 * Documents referencing a job (invoices.owner_type=3 → job). Posted documents
 * are book-scoped via post_acc; drafts have no account linkage and are
 * included under the same single-business-database assumption as the entity
 * tables themselves.
 */
export async function loadJobDocuments(
  jobGuid: string,
  bookAccountGuids: string[],
): Promise<RawJobDocRow[]> {
  const rows = await prisma.$queryRaw<JobDocDbRow[]>`
    SELECT
      i.guid,
      i.id,
      j.owner_type AS job_owner_type,
      (i.post_txn IS NOT NULL) AS posted,
      i.date_opened,
      i.date_posted,
      (
        SELECT SUM(ps.value_num::numeric / NULLIF(ps.value_denom, 0)::numeric)
        FROM splits ps
        WHERE ps.tx_guid = i.post_txn AND ps.account_guid = i.post_acc
      )::float8 AS post_total,
      (
        SELECT SUM(ls.value_num::numeric / NULLIF(ls.value_denom, 0)::numeric)
        FROM splits ls
        WHERE ls.lot_guid = i.post_lot
      )::float8 AS lot_balance,
      (
        SELECT SUM(
          (e.quantity_num::numeric / NULLIF(e.quantity_denom, 0)::numeric) *
          (COALESCE(e.i_price_num, e.b_price_num)::numeric /
           NULLIF(COALESCE(e.i_price_denom, e.b_price_denom), 0)::numeric)
        )
        FROM entries e
        WHERE e.invoice = i.guid OR e.bill = i.guid
      )::float8 AS entry_total,
      cm.mnemonic AS currency
    FROM invoices i
    JOIN jobs j ON j.guid = i.owner_guid
    LEFT JOIN commodities cm ON cm.guid = i.currency
    WHERE i.owner_type = ${OWNER_TYPE_JOB}
      AND i.owner_guid = ${jobGuid}
      AND (i.post_txn IS NULL OR i.post_acc = ANY(${bookAccountGuids}::text[]))
  `;

  return rows.map((r) => ({
    guid: r.guid,
    id: r.id,
    jobOwnerType: r.job_owner_type ?? OWNER_TYPE_CUSTOMER,
    posted: r.posted,
    dateOpened: r.date_opened ? r.date_opened.toISOString().slice(0, 10) : null,
    datePosted: r.date_posted ? r.date_posted.toISOString().slice(0, 10) : null,
    postTotal: r.post_total,
    lotBalance: r.lot_balance,
    entryTotal: r.entry_total,
    currency: r.currency ?? 'USD',
  }));
}

/** Full per-job rollup for the active book. */
export async function generateJobReport(
  jobGuid: string,
  bookAccountGuids: string[],
  options: { bookGuid?: string } = {},
): Promise<JobProfitabilityReport> {
  const [rows, job] = await Promise.all([
    loadJobDocuments(jobGuid, bookAccountGuids),
    getJobEx(jobGuid),
  ]);
  if (!job) throw new BusinessValidationError('Job not found');
  const report = buildJobReport(rows);
  const bookGuid = options.bookGuid ?? await bookGuidForAccounts(bookAccountGuids);
  if (!bookGuid) throw new BusinessValidationError('Active book could not be resolved');

  const [timeRows, costRows, taggedRows] = await Promise.all([
    prisma.$queryRaw<Array<{
      tracked_hours: number;
      labor_cost: number;
      unbilled_hours: number;
      unbilled_value: number;
    }>>`
      SELECT
        COALESCE(SUM(te.minutes) / 60.0, 0)::float8 AS tracked_hours,
        COALESCE(SUM(
          te.minutes / 60.0 *
          COALESCE(
            e.rate_num::numeric / NULLIF(e.rate_denom, 0)::numeric,
            te.rate,
            0
          )
        ), 0)::float8 AS labor_cost,
        COALESCE(SUM(te.minutes) FILTER (
          WHERE te.billable = TRUE AND te.invoiced_invoice_guid IS NULL
        ) / 60.0, 0)::float8 AS unbilled_hours,
        COALESCE(SUM(
          te.minutes / 60.0 * COALESCE(te.rate, ${job.rate ?? 0}, 0)
        ) FILTER (
          WHERE te.billable = TRUE AND te.invoiced_invoice_guid IS NULL
        ), 0)::float8 AS unbilled_value
      FROM gnucash_web_time_entries te
      LEFT JOIN gnucash_web_users u ON u.id = te.user_id
      LEFT JOIN employees e ON LOWER(e.username) = LOWER(u.username)
      WHERE te.job_guid = ${jobGuid}
        AND te.book_guid = ${bookGuid}
    `,
    prisma.$queryRaw<Array<{
      id: number;
      source_type: JobCostLink['sourceType'];
      source_id: string | null;
      description: string | null;
      cost_date: Date;
      amount: number;
      billable: boolean;
      invoiced_invoice_guid: string | null;
    }>>`
      SELECT id, source_type, source_id, description, cost_date,
             amount::float8 AS amount, billable, invoiced_invoice_guid
      FROM gnucash_web_job_cost_links
      WHERE job_guid = ${jobGuid}
        AND book_guid = ${bookGuid}
      ORDER BY cost_date DESC, id DESC
    `,
    prisma.$queryRaw<Array<{ tagged_cost: number }>>`
      SELECT COALESCE(SUM(
        s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric
      ), 0)::float8 AS tagged_cost
      FROM gnucash_web_transaction_tags tt
      JOIN gnucash_web_tags tag ON tag.id = tt.tag_id
      JOIN splits s ON s.tx_guid = tt.transaction_guid
      JOIN accounts a ON a.guid = s.account_guid
      WHERE LOWER(tag.name) IN (
        ${`job-${job.id.toLowerCase()}`},
        ${`job-${job.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`}
      )
        AND s.account_guid = ANY(${bookAccountGuids}::text[])
        AND a.account_type = 'EXPENSE'
        AND NOT EXISTS (
          SELECT 1 FROM gnucash_web_job_cost_links l
          WHERE l.job_guid = ${jobGuid}
            AND l.source_type = 'transaction'
            AND l.source_id = tt.transaction_guid
        )
    `,
  ]);

  const time = timeRows[0] ?? { tracked_hours: 0, labor_cost: 0, unbilled_hours: 0, unbilled_value: 0 };
  const costLinks: JobCostLink[] = costRows.map(row => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    description: row.description ?? '',
    costDate: row.cost_date.toISOString().slice(0, 10),
    amount: round2(Number(row.amount)),
    billable: row.billable,
    invoicedInvoiceGuid: row.invoiced_invoice_guid,
  }));
  const invoiceDocs = report.documents.filter(document => document.kind === 'invoice' && document.posted);
  const billCosts = report.documents
    .filter(document => document.kind === 'bill' && document.posted)
    .reduce((sum, document) => sum + document.total, 0);
  const revenue = round2(invoiceDocs.reduce((sum, document) => sum + document.total, 0));
  const collected = round2(invoiceDocs.reduce((sum, document) => sum + document.paid, 0));
  const accountsReceivable = round2(invoiceDocs.reduce((sum, document) => sum + document.due, 0));
  const explicitCosts = costLinks.reduce((sum, item) => sum + item.amount, 0);
  const taggedExpenseTotal = round2(Number(taggedRows[0]?.tagged_cost ?? 0));
  const directCosts = round2(billCosts + explicitCosts + taggedExpenseTotal);
  const laborCost = round2(Number(time.labor_cost ?? 0));
  const grossProfit = round2(revenue - directCosts - laborCost);
  const unbilledExpenseValue = round2(costLinks
    .filter(item => item.billable && !item.invoicedInvoiceGuid)
    .reduce((sum, item) => sum + item.amount, 0));
  const staleDate = new Date();
  staleDate.setUTCDate(staleDate.getUTCDate() - 30);
  const overdueCollections = round2(invoiceDocs
    .filter(document => document.due > 0 && document.datePosted && new Date(`${document.datePosted}T00:00:00Z`) < staleDate)
    .reduce((sum, document) => sum + document.due, 0));

  return {
    ...report,
    profitability: {
      revenue,
      collected,
      accountsReceivable,
      directCosts,
      laborCost,
      grossProfit,
      marginPercent: revenue > 0 ? round2(grossProfit / revenue * 100) : null,
      trackedHours: round2(Number(time.tracked_hours ?? 0)),
      unbilledHours: round2(Number(time.unbilled_hours ?? 0)),
      unbilledTimeValue: round2(Number(time.unbilled_value ?? 0)),
      unbilledExpenseValue,
      overdueCollections,
      costLinks,
      taggedExpenseTotal,
    },
  };
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function bookGuidForAccounts(accountGuids: string[]): Promise<string | null> {
  if (accountGuids.length === 0) return null;
  const rows = await prisma.$queryRaw<Array<{ guid: string }>>`
    WITH RECURSIVE ancestors AS (
      SELECT guid, parent_guid FROM accounts WHERE guid = ${accountGuids[0]}
      UNION ALL
      SELECT parent.guid, parent.parent_guid
      FROM accounts parent
      JOIN ancestors child ON child.parent_guid = parent.guid
    )
    SELECT b.guid
    FROM books b
    JOIN ancestors a ON a.guid = b.root_account_guid
    LIMIT 1
  `;
  return rows[0]?.guid ?? null;
}

export async function addJobCostLink(input: {
  bookGuid: string;
  jobGuid: string;
  userId: number;
  sourceType: JobCostLink['sourceType'];
  sourceId?: string | null;
  description?: string;
  costDate: string;
  amount: number;
  billable?: boolean;
}): Promise<JobCostLink> {
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) {
    throw new BusinessValidationError('Cost amount must be greater than zero');
  }
  if (!isDateOnly(input.costDate)) {
    throw new BusinessValidationError('Cost date must be YYYY-MM-DD');
  }
  if (!await getJob(input.jobGuid)) throw new BusinessValidationError('Job not found');
  if (input.sourceType === 'transaction' && input.sourceId) {
    const transaction = await prisma.transactions.findFirst({
      where: {
        guid: input.sourceId,
        splits: { some: { account_guid: { in: await getAccountGuidsForBook(input.bookGuid) } } },
      },
      select: { guid: true },
    });
    if (!transaction) throw new BusinessValidationError('Transaction is not in the active book');
  }
  const rows = await prisma.$queryRaw<Array<{
    id: number;
    source_type: JobCostLink['sourceType'];
    source_id: string | null;
    description: string | null;
    cost_date: Date;
    amount: number;
    billable: boolean;
    invoiced_invoice_guid: string | null;
  }>>`
    INSERT INTO gnucash_web_job_cost_links
      (book_guid, job_guid, source_type, source_id, description, cost_date, amount, billable, created_by)
    VALUES (
      ${input.bookGuid}, ${input.jobGuid}, ${input.sourceType}, ${input.sourceId ?? null},
      ${input.description?.trim() || null}, ${new Date(`${input.costDate}T12:00:00Z`)},
      ${Math.round(input.amount * 100) / 100}, ${input.billable ?? false}, ${input.userId}
    )
    RETURNING id, source_type, source_id, description, cost_date,
              amount::float8 AS amount, billable, invoiced_invoice_guid
  `;
  const row = rows[0];
  const created = {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    description: row.description ?? '',
    costDate: row.cost_date.toISOString().slice(0, 10),
    amount: round2(Number(row.amount)),
    billable: row.billable,
    invoicedInvoiceGuid: row.invoiced_invoice_guid,
  };
  await logAudit(
    'CREATE',
    'JOB_COST',
    String(row.id),
    null,
    created,
    { bookGuid: input.bookGuid, userId: input.userId },
  );
  return created;
}

export async function deleteJobCostLink(
  bookGuid: string,
  jobGuid: string,
  id: number,
  userId?: number,
): Promise<boolean> {
  const existing = await prisma.$queryRaw<Array<{
    id: number;
    source_type: string;
    source_id: string | null;
    description: string | null;
    cost_date: Date;
    amount: number;
    billable: boolean;
  }>>`
    SELECT id, source_type, source_id, description, cost_date,
           amount::float8 AS amount, billable
    FROM gnucash_web_job_cost_links
    WHERE id = ${id} AND book_guid = ${bookGuid} AND job_guid = ${jobGuid}
  `;
  const count = await prisma.$executeRaw`
    DELETE FROM gnucash_web_job_cost_links
    WHERE id = ${id} AND book_guid = ${bookGuid} AND job_guid = ${jobGuid}
  `;
  if (count > 0) {
    await logAudit(
      'DELETE',
      'JOB_COST',
      String(id),
      existing[0] ? {
        ...existing[0],
        cost_date: existing[0].cost_date.toISOString().slice(0, 10),
      } : null,
      null,
      { bookGuid, userId },
    );
  }
  return count > 0;
}
