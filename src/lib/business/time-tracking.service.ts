/**
 * Time tracking service (S4)
 *
 * Timesheet entries live in gnucash_web_time_entries (book-scoped via
 * book_guid; the referenced customers/jobs are the native GnuCash tables,
 * which are unscoped — validation checks existence + customer/job linkage).
 *
 * Features:
 *   - CRUD with customer/job validation (a job must belong to the entry's
 *     customer; a job-only entry inherits the job's customer).
 *   - Timer: one running timer per user per book (timer_started_at set).
 *     stop() adds the elapsed whole minutes and clears the flag.
 *   - Unbilled summary: billable, not-yet-invoiced entries grouped per
 *     customer (and per job within the customer) with hours and amounts.
 *   - generateInvoiceLines(): creates a DRAFT invoice through the existing
 *     invoice engine — one line per time entry (description, hours x rate)
 *     — then marks the entries invoiced with the new invoice guid.
 *
 * Rate default: job 'job-rate' slot, else the customer's most recent
 * time-entry rate in this book ("customer default"), else null (manual).
 */

import prisma from '@/lib/prisma';
import { getJobEx } from './jobs.service';
import {
  createInvoice,
  InvoiceValidationError,
  type InvoiceDetailView,
  type InvoiceEntryInput,
} from './invoice-engine';

// ---------------------------------------------------------------------------
// Errors (mapped to HTTP by the API routes: 400 / 404 / 409)
// ---------------------------------------------------------------------------

export class TimeTrackingValidationError extends Error {}
export class TimeTrackingNotFoundError extends Error {}
export class TimeTrackingStateError extends Error {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimeEntryDTO {
  id: number;
  customerGuid: string | null;
  customerName: string | null;
  jobGuid: string | null;
  jobName: string | null;
  /** ISO date (YYYY-MM-DD). */
  entryDate: string;
  minutes: number;
  /** Decimal hours, rounded to 2 places. */
  hours: number;
  rate: number | null;
  /** hours x rate, rounded to 2 places; null when rate is unset. */
  amount: number | null;
  description: string;
  billable: boolean;
  invoicedInvoiceGuid: string | null;
  running: boolean;
  /** ISO timestamp while the timer runs, else null. */
  timerStartedAt: string | null;
}

export interface TimeEntryInput {
  customerGuid?: string | null;
  jobGuid?: string | null;
  /** ISO date (YYYY-MM-DD). */
  entryDate: string;
  minutes: number;
  /** undefined => resolve the default rate; null => explicitly no rate. */
  rate?: number | null;
  description?: string;
  billable?: boolean;
}

export interface TimeEntryPatch {
  customerGuid?: string | null;
  jobGuid?: string | null;
  entryDate?: string;
  minutes?: number;
  rate?: number | null;
  description?: string;
  billable?: boolean;
}

export interface ListTimeEntriesOptions {
  /** ISO dates (inclusive). */
  startDate?: string;
  endDate?: string;
  customerGuid?: string;
  jobGuid?: string;
}

/** Minimal shape the pure aggregation helpers need (DB-free for tests). */
export interface UnbilledEntryLike {
  id: number;
  customerGuid: string | null;
  customerName: string | null;
  jobGuid: string | null;
  jobName: string | null;
  entryDate: string;
  minutes: number;
  rate: number | null;
  description: string;
}

export interface UnbilledJobGroup {
  jobGuid: string | null;
  jobName: string | null;
  minutes: number;
  hours: number;
  /** Sum of hours x rate over rated entries. */
  amount: number;
  entryCount: number;
}

export interface UnbilledCustomerGroup {
  customerGuid: string;
  customerName: string;
  minutes: number;
  hours: number;
  amount: number;
  /** Entries with no rate — they cannot be invoiced until a rate is set. */
  missingRateCount: number;
  jobs: UnbilledJobGroup[];
  entries: UnbilledEntryLike[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Minutes -> decimal hours, rounded to 2 places (invoice quantity denom 100). */
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** hours x rate rounded to cents; null when the rate is unset. */
export function entryAmount(minutes: number, rate: number | null): number | null {
  if (rate == null) return null;
  return Math.round(minutesToHours(minutes) * rate * 100) / 100;
}

/** Whole minutes elapsed since the timer started (never less than 1). */
export function computeElapsedMinutes(startedAt: Date, now: Date): number {
  const ms = now.getTime() - startedAt.getTime();
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * Group unbilled entries per customer, with per-job subtotals. Entries with
 * no customer (personal/uncategorized time) are excluded — they cannot be
 * invoiced. Amounts sum hours x rate over entries that carry a rate.
 */
export function summarizeUnbilled(entries: ReadonlyArray<UnbilledEntryLike>): UnbilledCustomerGroup[] {
  const byCustomer = new Map<string, UnbilledCustomerGroup>();

  for (const e of entries) {
    if (!e.customerGuid) continue;
    let group = byCustomer.get(e.customerGuid);
    if (!group) {
      group = {
        customerGuid: e.customerGuid,
        customerName: e.customerName ?? e.customerGuid,
        minutes: 0,
        hours: 0,
        amount: 0,
        missingRateCount: 0,
        jobs: [],
        entries: [],
      };
      byCustomer.set(e.customerGuid, group);
    }
    group.minutes += e.minutes;
    const amount = entryAmount(e.minutes, e.rate);
    if (amount == null) group.missingRateCount += 1;
    else group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.entries.push(e);

    const jobKey = e.jobGuid ?? '';
    let job = group.jobs.find((j) => (j.jobGuid ?? '') === jobKey);
    if (!job) {
      job = { jobGuid: e.jobGuid, jobName: e.jobName, minutes: 0, hours: 0, amount: 0, entryCount: 0 };
      group.jobs.push(job);
    }
    job.minutes += e.minutes;
    job.entryCount += 1;
    if (amount != null) job.amount = Math.round((job.amount + amount) * 100) / 100;
  }

  const groups = Array.from(byCustomer.values());
  for (const g of groups) {
    g.hours = minutesToHours(g.minutes);
    for (const j of g.jobs) j.hours = minutesToHours(j.minutes);
    g.jobs.sort((a, b) => (a.jobName ?? '').localeCompare(b.jobName ?? ''));
    g.entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id - b.id);
  }
  groups.sort((a, b) => a.customerName.localeCompare(b.customerName));
  return groups;
}

/**
 * Time entries -> invoice engine entry lines: one line per entry, quantity =
 * decimal hours, price = the entry's rate, description carries the date and
 * (job / description) context. Throws when an entry has no rate or no time.
 */
export function buildInvoiceEntryInputs(entries: ReadonlyArray<UnbilledEntryLike>): InvoiceEntryInput[] {
  return entries.map((e) => {
    if (e.rate == null) {
      throw new TimeTrackingValidationError(
        `Time entry ${e.id} (${e.entryDate}) has no rate — set a rate before invoicing`,
      );
    }
    if (e.minutes <= 0) {
      throw new TimeTrackingValidationError(
        `Time entry ${e.id} (${e.entryDate}) has no recorded time`,
      );
    }
    const parts = [e.entryDate];
    if (e.jobName) parts.push(e.jobName);
    parts.push(e.description?.trim() ? e.description.trim() : 'Time');
    return {
      description: parts.join(' — '),
      action: 'Hours',
      date: e.entryDate,
      quantity: minutesToHours(e.minutes),
      price: e.rate,
      accountGuid: '', // filled by the caller with the chosen income account
    };
  });
}

// ---------------------------------------------------------------------------
// Validation + mapping
// ---------------------------------------------------------------------------

function parseIsoDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
    throw new TimeTrackingValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
  }
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    throw new TimeTrackingValidationError(`Invalid ${field}: '${value}'`);
  }
  return d;
}

/**
 * Validate the customer/job pair against the native tables. Returns the
 * effective customer guid (a job-only entry inherits the job's customer).
 */
async function validateCustomerJob(
  customerGuid: string | null | undefined,
  jobGuid: string | null | undefined,
): Promise<{ customerGuid: string | null; jobGuid: string | null }> {
  let effectiveCustomer = customerGuid ?? null;

  if (jobGuid) {
    const job = await prisma.jobs.findUnique({
      where: { guid: jobGuid },
      select: { guid: true, owner_type: true, owner_guid: true },
    });
    if (!job) throw new TimeTrackingNotFoundError(`Job not found: ${jobGuid}`);
    // Owner type 2 = customer (invoice-engine OWNER_TYPE_CUSTOMER)
    if (job.owner_type !== 2 || !job.owner_guid) {
      throw new TimeTrackingValidationError('Time can only be tracked against customer-owned jobs');
    }
    if (effectiveCustomer && effectiveCustomer !== job.owner_guid) {
      throw new TimeTrackingValidationError('Job does not belong to the selected customer');
    }
    effectiveCustomer = job.owner_guid;
  }

  if (effectiveCustomer) {
    const customer = await prisma.customers.findUnique({
      where: { guid: effectiveCustomer },
      select: { guid: true },
    });
    if (!customer) throw new TimeTrackingNotFoundError(`Customer not found: ${effectiveCustomer}`);
  }

  return { customerGuid: effectiveCustomer, jobGuid: jobGuid ?? null };
}

type TimeEntryRow = NonNullable<Awaited<ReturnType<typeof prisma.gnucash_web_time_entries.findUnique>>>;

async function nameLookups(rows: ReadonlyArray<TimeEntryRow>): Promise<{
  customers: Map<string, string>;
  jobs: Map<string, string>;
}> {
  const customerGuids = Array.from(new Set(rows.map((r) => r.customer_guid).filter((g): g is string => Boolean(g))));
  const jobGuids = Array.from(new Set(rows.map((r) => r.job_guid).filter((g): g is string => Boolean(g))));
  const [customers, jobs] = await Promise.all([
    customerGuids.length
      ? prisma.customers.findMany({ where: { guid: { in: customerGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
    jobGuids.length
      ? prisma.jobs.findMany({ where: { guid: { in: jobGuids } }, select: { guid: true, name: true } })
      : Promise.resolve([]),
  ]);
  return {
    customers: new Map(customers.map((c) => [c.guid, c.name])),
    jobs: new Map(jobs.map((j) => [j.guid, j.name])),
  };
}

function mapRow(
  row: TimeEntryRow,
  lookups: { customers: Map<string, string>; jobs: Map<string, string> },
): TimeEntryDTO {
  const rate = row.rate == null ? null : Number(row.rate);
  return {
    id: row.id,
    customerGuid: row.customer_guid,
    customerName: row.customer_guid ? (lookups.customers.get(row.customer_guid) ?? null) : null,
    jobGuid: row.job_guid,
    jobName: row.job_guid ? (lookups.jobs.get(row.job_guid) ?? null) : null,
    entryDate: row.entry_date.toISOString().slice(0, 10),
    minutes: row.minutes,
    hours: minutesToHours(row.minutes),
    rate,
    amount: entryAmount(row.minutes, rate),
    description: row.description ?? '',
    billable: row.billable,
    invoicedInvoiceGuid: row.invoiced_invoice_guid,
    running: row.timer_started_at != null,
    timerStartedAt: row.timer_started_at ? row.timer_started_at.toISOString() : null,
  };
}

async function mapRows(rows: TimeEntryRow[]): Promise<TimeEntryDTO[]> {
  const lookups = await nameLookups(rows);
  return rows.map((r) => mapRow(r, lookups));
}

// ---------------------------------------------------------------------------
// Rate resolution
// ---------------------------------------------------------------------------

/**
 * Default rate for a new entry: the job's 'job-rate' slot, else the
 * customer's most recent rated time entry in this book, else null (manual).
 */
export async function resolveDefaultRate(
  bookGuid: string,
  customerGuid: string | null,
  jobGuid: string | null,
): Promise<number | null> {
  if (jobGuid) {
    const job = await getJobEx(jobGuid);
    if (job?.rate != null && job.rate > 0) return job.rate;
  }
  if (customerGuid) {
    const last = await prisma.gnucash_web_time_entries.findFirst({
      where: { book_guid: bookGuid, customer_guid: customerGuid, rate: { not: null } },
      orderBy: [{ entry_date: 'desc' }, { id: 'desc' }],
      select: { rate: true },
    });
    if (last?.rate != null) return Number(last.rate);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listTimeEntries(
  bookGuid: string,
  options: ListTimeEntriesOptions = {},
): Promise<TimeEntryDTO[]> {
  const rows = await prisma.gnucash_web_time_entries.findMany({
    where: {
      book_guid: bookGuid,
      ...(options.customerGuid ? { customer_guid: options.customerGuid } : {}),
      ...(options.jobGuid ? { job_guid: options.jobGuid } : {}),
      ...(options.startDate || options.endDate
        ? {
            entry_date: {
              ...(options.startDate ? { gte: parseIsoDate(options.startDate, 'startDate') } : {}),
              ...(options.endDate ? { lte: parseIsoDate(options.endDate, 'endDate') } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ entry_date: 'asc' }, { id: 'asc' }],
  });
  return mapRows(rows);
}

export async function getTimeEntry(bookGuid: string, id: number): Promise<TimeEntryDTO | null> {
  const row = await prisma.gnucash_web_time_entries.findUnique({ where: { id } });
  if (!row || row.book_guid !== bookGuid) return null;
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

export async function createTimeEntry(
  bookGuid: string,
  userId: number,
  input: TimeEntryInput,
): Promise<TimeEntryDTO> {
  const entryDate = parseIsoDate(input.entryDate, 'entryDate');
  if (!Number.isInteger(input.minutes) || input.minutes < 0) {
    throw new TimeTrackingValidationError('minutes must be a non-negative integer');
  }
  if (input.rate != null && (!isFinite(input.rate) || input.rate < 0)) {
    throw new TimeTrackingValidationError('rate must be a non-negative number');
  }
  const { customerGuid, jobGuid } = await validateCustomerJob(input.customerGuid, input.jobGuid);

  const rate =
    input.rate !== undefined ? input.rate : await resolveDefaultRate(bookGuid, customerGuid, jobGuid);

  const row = await prisma.gnucash_web_time_entries.create({
    data: {
      book_guid: bookGuid,
      user_id: userId,
      customer_guid: customerGuid,
      job_guid: jobGuid,
      entry_date: entryDate,
      minutes: input.minutes,
      rate,
      description: input.description ?? '',
      billable: input.billable ?? true,
    },
  });
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

export async function updateTimeEntry(
  bookGuid: string,
  id: number,
  patch: TimeEntryPatch,
): Promise<TimeEntryDTO> {
  const existing = await prisma.gnucash_web_time_entries.findUnique({ where: { id } });
  if (!existing || existing.book_guid !== bookGuid) {
    throw new TimeTrackingNotFoundError(`Time entry not found: ${id}`);
  }
  if (existing.invoiced_invoice_guid) {
    throw new TimeTrackingStateError('This entry is already invoiced and can no longer be edited');
  }
  if (patch.minutes !== undefined && (!Number.isInteger(patch.minutes) || patch.minutes < 0)) {
    throw new TimeTrackingValidationError('minutes must be a non-negative integer');
  }
  if (patch.rate != null && (!isFinite(patch.rate) || patch.rate < 0)) {
    throw new TimeTrackingValidationError('rate must be a non-negative number');
  }

  const nextCustomer = patch.customerGuid !== undefined ? patch.customerGuid : existing.customer_guid;
  const nextJob = patch.jobGuid !== undefined ? patch.jobGuid : existing.job_guid;
  const { customerGuid, jobGuid } = await validateCustomerJob(nextCustomer, nextJob);

  const row = await prisma.gnucash_web_time_entries.update({
    where: { id },
    data: {
      customer_guid: customerGuid,
      job_guid: jobGuid,
      ...(patch.entryDate !== undefined ? { entry_date: parseIsoDate(patch.entryDate, 'entryDate') } : {}),
      ...(patch.minutes !== undefined ? { minutes: patch.minutes } : {}),
      ...(patch.rate !== undefined ? { rate: patch.rate } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.billable !== undefined ? { billable: patch.billable } : {}),
      updated_at: new Date(),
    },
  });
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

export async function deleteTimeEntry(bookGuid: string, id: number): Promise<void> {
  const existing = await prisma.gnucash_web_time_entries.findUnique({ where: { id } });
  if (!existing || existing.book_guid !== bookGuid) {
    throw new TimeTrackingNotFoundError(`Time entry not found: ${id}`);
  }
  if (existing.invoiced_invoice_guid) {
    throw new TimeTrackingStateError('This entry is already invoiced and cannot be deleted');
  }
  await prisma.gnucash_web_time_entries.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

export async function getRunningTimer(bookGuid: string, userId: number): Promise<TimeEntryDTO | null> {
  const row = await prisma.gnucash_web_time_entries.findFirst({
    where: { book_guid: bookGuid, user_id: userId, timer_started_at: { not: null } },
    orderBy: { id: 'desc' },
  });
  if (!row) return null;
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

export interface StartTimerInput {
  customerGuid?: string | null;
  jobGuid?: string | null;
  description?: string;
}

/** Start a timer — one running timer per user per book. */
export async function startTimer(
  bookGuid: string,
  userId: number,
  input: StartTimerInput,
): Promise<TimeEntryDTO> {
  const { customerGuid, jobGuid } = await validateCustomerJob(input.customerGuid, input.jobGuid);
  const rate = await resolveDefaultRate(bookGuid, customerGuid, jobGuid);
  const now = new Date();
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');

  const row = await prisma.$transaction(async (tx) => {
    const running = await tx.gnucash_web_time_entries.findFirst({
      where: { book_guid: bookGuid, user_id: userId, timer_started_at: { not: null } },
      select: { id: true },
    });
    if (running) {
      throw new TimeTrackingStateError('A timer is already running — stop it before starting another');
    }
    return tx.gnucash_web_time_entries.create({
      data: {
        book_guid: bookGuid,
        user_id: userId,
        customer_guid: customerGuid,
        job_guid: jobGuid,
        entry_date: today,
        minutes: 0,
        rate,
        description: input.description ?? '',
        billable: true,
        timer_started_at: now,
      },
    });
  });
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

/** Stop the running timer: add the elapsed whole minutes and clear the flag. */
export async function stopTimer(bookGuid: string, userId: number): Promise<TimeEntryDTO> {
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const running = await tx.gnucash_web_time_entries.findFirst({
      where: { book_guid: bookGuid, user_id: userId, timer_started_at: { not: null } },
      orderBy: { id: 'desc' },
    });
    if (!running || !running.timer_started_at) {
      throw new TimeTrackingStateError('No timer is running');
    }
    const elapsed = computeElapsedMinutes(running.timer_started_at, now);
    return tx.gnucash_web_time_entries.update({
      where: { id: running.id },
      data: { minutes: running.minutes + elapsed, timer_started_at: null, updated_at: now },
    });
  });
  const lookups = await nameLookups([row]);
  return mapRow(row, lookups);
}

// ---------------------------------------------------------------------------
// Unbilled summary + invoicing
// ---------------------------------------------------------------------------

/** Billable, not-yet-invoiced, non-running entries grouped per customer. */
export async function getUnbilledSummary(bookGuid: string): Promise<UnbilledCustomerGroup[]> {
  const rows = await prisma.gnucash_web_time_entries.findMany({
    where: {
      book_guid: bookGuid,
      billable: true,
      invoiced_invoice_guid: null,
      timer_started_at: null,
      minutes: { gt: 0 },
      customer_guid: { not: null },
    },
    orderBy: [{ entry_date: 'asc' }, { id: 'asc' }],
  });
  const dtos = await mapRows(rows);
  return summarizeUnbilled(dtos);
}

export interface GenerateInvoiceLinesResult {
  invoice: InvoiceDetailView;
  entryIds: number[];
}

/**
 * Create a DRAFT invoice for a customer from the selected unbilled time
 * entries (one engine line per entry: description, hours x rate on the given
 * income account), then mark the entries invoiced with the new invoice guid.
 */
export async function generateInvoiceLines(
  bookGuid: string,
  customerGuid: string,
  entryIds: number[],
  incomeAccountGuid: string,
): Promise<GenerateInvoiceLinesResult> {
  if (!entryIds || entryIds.length === 0) {
    throw new TimeTrackingValidationError('Select at least one time entry to invoice');
  }
  if (!incomeAccountGuid) {
    throw new TimeTrackingValidationError('An income account is required for the invoice lines');
  }
  const uniqueIds = Array.from(new Set(entryIds));

  const rows = await prisma.gnucash_web_time_entries.findMany({
    where: { id: { in: uniqueIds }, book_guid: bookGuid },
  });
  if (rows.length !== uniqueIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !found.has(id));
    throw new TimeTrackingNotFoundError(`Time entries not found in this book: ${missing.join(', ')}`);
  }
  for (const row of rows) {
    if (row.invoiced_invoice_guid) {
      throw new TimeTrackingStateError(`Time entry ${row.id} is already invoiced`);
    }
    if (!row.billable) {
      throw new TimeTrackingValidationError(`Time entry ${row.id} is not billable`);
    }
    if (row.timer_started_at) {
      throw new TimeTrackingStateError(`Time entry ${row.id} has a running timer — stop it first`);
    }
    if (row.customer_guid !== customerGuid) {
      throw new TimeTrackingValidationError(`Time entry ${row.id} does not belong to this customer`);
    }
  }

  const dtos = await mapRows(
    [...rows].sort((a, b) => a.entry_date.getTime() - b.entry_date.getTime() || a.id - b.id),
  );
  const entries = buildInvoiceEntryInputs(dtos).map((line) => ({
    ...line,
    accountGuid: incomeAccountGuid,
  }));

  let invoice: InvoiceDetailView;
  try {
    invoice = await createInvoice({
      ownerType: 'customer',
      ownerGuid: customerGuid,
      entries,
      bookGuid,
      notes: 'Generated from tracked time',
    });
  } catch (error) {
    if (error instanceof InvoiceValidationError) {
      throw new TimeTrackingValidationError(error.message);
    }
    throw error;
  }

  await prisma.gnucash_web_time_entries.updateMany({
    where: { id: { in: uniqueIds } },
    data: { invoiced_invoice_guid: invoice.guid, updated_at: new Date() },
  });

  return { invoice, entryIds: uniqueIds };
}
