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
): Promise<JobReport> {
  const rows = await loadJobDocuments(jobGuid, bookAccountGuids);
  return buildJobReport(rows);
}
