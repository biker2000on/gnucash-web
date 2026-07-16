/**
 * Estimates (quotes) — CRUD, per-book numbering, status transitions, and
 * conversion into real draft invoices via the invoice engine.
 *
 * Estimates live entirely in app tables (gnucash_web_estimates +
 * gnucash_web_estimate_lines); they touch GnuCash-native tables only at
 * conversion time, when the estimate's lines become the entries of a new
 * DRAFT customer invoice (createInvoice from invoice-engine).
 *
 * Status machine:
 *   draft <-> sent -> accepted | declined     (accepted/declined can be
 *   re-sent or re-decided while unconverted)  converted is terminal and only
 *   reachable through convertEstimateToInvoice().
 *
 * Numbering: EST-0001 style, per book, derived from the max numeric suffix
 * of existing EST-n numbers in the same book.
 */

import prisma from '@/lib/prisma';
import {
  createInvoice,
  deleteInvoice,
  InvoiceNotFoundError,
  InvoiceStateError,
  InvoiceValidationError,
  type InvoiceEntryInput,
} from './invoice-engine';

// Reuse the invoice error family so mapInvoiceError covers estimate routes.
export {
  InvoiceNotFoundError as EstimateNotFoundError,
  InvoiceStateError as EstimateStateError,
  InvoiceValidationError as EstimateValidationError,
};

export const ESTIMATE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'converted'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Allowed manual status transitions. 'converted' is terminal and is never a
 * manual target — conversion happens exclusively via convertEstimateToInvoice.
 */
export function canTransitionEstimate(from: EstimateStatus, to: EstimateStatus): boolean {
  if (from === 'converted') return false;
  if (to === 'converted') return false;
  if (from === to) return true;
  const allowed: Record<Exclude<EstimateStatus, 'converted'>, EstimateStatus[]> = {
    draft: ['sent', 'accepted', 'declined'],
    sent: ['draft', 'accepted', 'declined'],
    accepted: ['sent', 'declined'],
    declined: ['sent', 'accepted'],
  };
  return allowed[from].includes(to);
}

/**
 * Next estimate number from the existing numbers of a book: max numeric
 * suffix of EST-n entries + 1, zero-padded to 4 (EST-0001, EST-0002, ...).
 */
export function nextEstimateNo(existing: Array<string | null>): string {
  let max = 0;
  for (const no of existing) {
    const m = /^EST-(\d+)$/i.exec(no ?? '');
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `EST-${String(max + 1).padStart(4, '0')}`;
}

export interface EstimateLineInput {
  description?: string;
  quantity: number;
  unitPrice: number;
  incomeAccountGuid?: string | null;
}

/** Round to cents (half away from zero). */
function roundCents(v: number): number {
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(v) * 100)) / 100;
}

/** Sum of quantity x unitPrice across lines, rounded per line to cents. */
export function estimateTotal(lines: Array<{ quantity: number; unitPrice: number }>): number {
  return roundCents(lines.reduce((s, l) => s + roundCents(l.quantity * l.unitPrice), 0));
}

/**
 * Map estimate lines to invoice-engine entries for conversion. Every line
 * must carry an income account (the invoice engine posts per-line nets there).
 */
export function estimateLinesToInvoiceEntries(
  lines: Array<{
    description?: string | null;
    quantity: number;
    unitPrice: number;
    incomeAccountGuid?: string | null;
  }>,
): InvoiceEntryInput[] {
  if (lines.length === 0) {
    throw new InvoiceValidationError('Estimate has no lines to convert');
  }
  return lines.map((l, i) => {
    if (!l.incomeAccountGuid) {
      throw new InvoiceValidationError(
        `Line ${i + 1} has no income account — assign one before converting`,
      );
    }
    return {
      description: l.description ?? '',
      quantity: l.quantity,
      price: l.unitPrice,
      accountGuid: l.incomeAccountGuid,
    };
  });
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface EstimateLineView {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number;
  incomeAccountGuid: string | null;
  amount: number;
}

export interface EstimateView {
  id: number;
  estimateNo: string;
  customerGuid: string | null;
  customerName: string | null;
  dateCreated: string | null;
  expires: string | null;
  status: EstimateStatus;
  convertedInvoiceGuid: string | null;
  notes: string | null;
  terms: string | null;
  lines: EstimateLineView[];
  total: number;
}

export interface CreateEstimateInput {
  customerGuid?: string | null;
  dateCreated?: string;
  expires?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines: EstimateLineInput[];
}

export interface UpdateEstimateInput extends Partial<CreateEstimateInput> {
  status?: EstimateStatus;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EstimateRow = NonNullable<Awaited<ReturnType<typeof prisma.gnucash_web_estimates.findFirst>>>;
type LineRow = Awaited<ReturnType<typeof prisma.gnucash_web_estimate_lines.findMany>>[number];

function isoDateOrNull(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function parseDateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvoiceValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new InvoiceValidationError(`Invalid ${field}: '${value}'`);
  return d;
}

function rowToView(
  row: EstimateRow,
  lines: LineRow[],
  customerName: string | null,
): EstimateView {
  const lineViews: EstimateLineView[] = lines.map((l) => {
    const quantity = Number(l.quantity);
    const unitPrice = Number(l.unit_price);
    return {
      id: l.id,
      description: l.description ?? '',
      quantity,
      unitPrice,
      incomeAccountGuid: l.income_account_guid ?? null,
      amount: roundCents(quantity * unitPrice),
    };
  });
  return {
    id: row.id,
    estimateNo: row.estimate_no ?? `EST-${row.id}`,
    customerGuid: row.customer_guid ?? null,
    customerName,
    dateCreated: isoDateOrNull(row.date_created),
    expires: isoDateOrNull(row.expires),
    status: (ESTIMATE_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as EstimateStatus)
      : 'draft',
    convertedInvoiceGuid: row.converted_invoice_guid ?? null,
    notes: row.notes ?? null,
    terms: row.terms ?? null,
    lines: lineViews,
    total: roundCents(lineViews.reduce((s, l) => s + l.amount, 0)),
  };
}

async function customerNames(guids: Array<string | null>): Promise<Map<string, string>> {
  const unique = Array.from(new Set(guids.filter((g): g is string => Boolean(g))));
  if (unique.length === 0) return new Map();
  const rows = await prisma.customers.findMany({
    where: { guid: { in: unique } },
    select: { guid: true, name: true },
  });
  return new Map(rows.map((r) => [r.guid, r.name]));
}

async function fetchEstimateOrThrow(bookGuid: string, id: number): Promise<EstimateRow> {
  const row = await prisma.gnucash_web_estimates.findFirst({
    where: { id, book_guid: bookGuid },
  });
  if (!row) throw new InvoiceNotFoundError(`Estimate not found: ${id}`);
  return row;
}

function validateLines(lines: EstimateLineInput[]): void {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InvoiceValidationError('At least one line is required');
  }
  for (const l of lines) {
    if (typeof l.quantity !== 'number' || !isFinite(l.quantity)) {
      throw new InvoiceValidationError('Line quantity must be a finite number');
    }
    if (typeof l.unitPrice !== 'number' || !isFinite(l.unitPrice)) {
      throw new InvoiceValidationError('Line unit price must be a finite number');
    }
  }
}

async function validateCustomer(customerGuid: string): Promise<void> {
  const c = await prisma.customers.findUnique({
    where: { guid: customerGuid },
    select: { guid: true },
  });
  if (!c) throw new InvoiceValidationError(`Customer not found: ${customerGuid}`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listEstimates(
  bookGuid: string,
  filters: { status?: EstimateStatus } = {},
): Promise<EstimateView[]> {
  const rows = await prisma.gnucash_web_estimates.findMany({
    where: { book_guid: bookGuid, ...(filters.status ? { status: filters.status } : {}) },
    include: { lines: { orderBy: { sort_order: 'asc' } } },
    orderBy: [{ date_created: 'desc' }, { id: 'desc' }],
  });
  const names = await customerNames(rows.map((r) => r.customer_guid));
  return rows.map((r) =>
    rowToView(r, r.lines, r.customer_guid ? (names.get(r.customer_guid) ?? null) : null),
  );
}

export async function getEstimate(bookGuid: string, id: number): Promise<EstimateView> {
  const row = await fetchEstimateOrThrow(bookGuid, id);
  const lines = await prisma.gnucash_web_estimate_lines.findMany({
    where: { estimate_id: id },
    orderBy: { sort_order: 'asc' },
  });
  const names = await customerNames([row.customer_guid]);
  return rowToView(row, lines, row.customer_guid ? (names.get(row.customer_guid) ?? null) : null);
}

export async function createEstimate(
  bookGuid: string,
  input: CreateEstimateInput,
): Promise<EstimateView> {
  validateLines(input.lines);
  if (input.customerGuid) await validateCustomer(input.customerGuid);

  const dateCreated = input.dateCreated
    ? parseDateOnly(input.dateCreated, 'dateCreated')
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const expires = input.expires ? parseDateOnly(input.expires, 'expires') : null;

  const id = await prisma.$transaction(async (tx) => {
    const existing = await tx.gnucash_web_estimates.findMany({
      where: { book_guid: bookGuid },
      select: { estimate_no: true },
    });
    const estimateNo = nextEstimateNo(existing.map((e) => e.estimate_no));

    const row = await tx.gnucash_web_estimates.create({
      data: {
        book_guid: bookGuid,
        estimate_no: estimateNo,
        customer_guid: input.customerGuid ?? null,
        date_created: dateCreated,
        expires,
        status: 'draft',
        notes: input.notes ?? null,
        terms: input.terms ?? null,
      },
    });
    await tx.gnucash_web_estimate_lines.createMany({
      data: input.lines.map((l, i) => ({
        estimate_id: row.id,
        description: l.description ?? null,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        income_account_guid: l.incomeAccountGuid ?? null,
        sort_order: i,
      })),
    });
    return row.id;
  });

  return getEstimate(bookGuid, id);
}

export async function updateEstimate(
  bookGuid: string,
  id: number,
  input: UpdateEstimateInput,
): Promise<EstimateView> {
  const row = await fetchEstimateOrThrow(bookGuid, id);
  const currentStatus = row.status as EstimateStatus;

  if (currentStatus === 'converted') {
    throw new InvoiceStateError('A converted estimate can no longer be edited');
  }

  if (input.status !== undefined) {
    if (!(ESTIMATE_STATUSES as readonly string[]).includes(input.status)) {
      throw new InvoiceValidationError(`Invalid status: ${input.status}`);
    }
    if (!canTransitionEstimate(currentStatus, input.status)) {
      throw new InvoiceStateError(`Cannot change status from ${currentStatus} to ${input.status}`);
    }
  }

  if (input.lines !== undefined) validateLines(input.lines);
  if (input.customerGuid) await validateCustomer(input.customerGuid);

  await prisma.$transaction(async (tx) => {
    await tx.gnucash_web_estimates.update({
      where: { id },
      data: {
        customer_guid:
          input.customerGuid !== undefined ? (input.customerGuid ?? null) : row.customer_guid,
        date_created: input.dateCreated
          ? parseDateOnly(input.dateCreated, 'dateCreated')
          : row.date_created,
        expires:
          input.expires !== undefined
            ? input.expires
              ? parseDateOnly(input.expires, 'expires')
              : null
            : row.expires,
        status: input.status ?? row.status,
        notes: input.notes !== undefined ? (input.notes ?? null) : row.notes,
        terms: input.terms !== undefined ? (input.terms ?? null) : row.terms,
        updated_at: new Date(),
      },
    });
    if (input.lines !== undefined) {
      await tx.gnucash_web_estimate_lines.deleteMany({ where: { estimate_id: id } });
      await tx.gnucash_web_estimate_lines.createMany({
        data: input.lines.map((l, i) => ({
          estimate_id: id,
          description: l.description ?? null,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          income_account_guid: l.incomeAccountGuid ?? null,
          sort_order: i,
        })),
      });
    }
  });

  return getEstimate(bookGuid, id);
}

export async function deleteEstimate(bookGuid: string, id: number): Promise<void> {
  const row = await fetchEstimateOrThrow(bookGuid, id);
  if (row.status === 'converted') {
    throw new InvoiceStateError(
      'A converted estimate cannot be deleted — it documents the invoice origin',
    );
  }
  // Lines cascade via the FK.
  await prisma.gnucash_web_estimates.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an estimate into a new DRAFT customer invoice via the invoice
 * engine. Declined and already-converted estimates are rejected. On success
 * the estimate is marked converted and stores the new invoice's guid.
 */
export async function convertEstimateToInvoice(
  bookGuid: string,
  id: number,
): Promise<{ estimate: EstimateView; invoiceGuid: string }> {
  const row = await fetchEstimateOrThrow(bookGuid, id);
  const status = row.status as EstimateStatus;
  if (status === 'converted') {
    throw new InvoiceStateError('Estimate is already converted');
  }
  if (status === 'declined') {
    throw new InvoiceStateError('A declined estimate cannot be converted');
  }
  if (!row.customer_guid) {
    throw new InvoiceValidationError('Assign a customer before converting');
  }
  await validateCustomer(row.customer_guid);

  const lineRows = await prisma.gnucash_web_estimate_lines.findMany({
    where: { estimate_id: id },
    orderBy: { sort_order: 'asc' },
  });
  const entries = estimateLinesToInvoiceEntries(
    lineRows.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      incomeAccountGuid: l.income_account_guid,
    })),
  );

  const estimateNo = row.estimate_no ?? `EST-${row.id}`;
  const invoice = await createInvoice({
    ownerType: 'customer',
    ownerGuid: row.customer_guid,
    notes: [`Converted from estimate ${estimateNo}`, row.notes?.trim() || null]
      .filter(Boolean)
      .join('\n'),
    billingId: estimateNo,
    entries,
    bookGuid,
  });

  try {
    await prisma.gnucash_web_estimates.update({
      where: { id },
      data: {
        status: 'converted',
        converted_invoice_guid: invoice.guid,
        updated_at: new Date(),
      },
    });
  } catch (err) {
    // Keep the books consistent: if we cannot record the conversion, remove
    // the just-created draft invoice rather than leaving an orphan.
    await deleteInvoice(invoice.guid).catch(() => {});
    throw err;
  }

  const estimate = await getEstimate(bookGuid, id);
  return { estimate, invoiceGuid: invoice.guid };
}
