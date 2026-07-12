/**
 * Employee Expense Vouchers — thin wrappers over the existing invoice engine.
 *
 * A GnuCash expense voucher is an employee-owned invoice document
 * (invoices.owner_type = 5). It behaves exactly like a vendor bill at the
 * ledger level: entries live in the b_* columns, posting CREDITS Accounts
 * Payable and DEBITS the expense accounts, and reimbursement flows through
 * the same lot-linked payment path as bill payments. The engine gained
 * minimal employee-owner support (resolveOwner / applyPayment / listPayments)
 * so everything here simply delegates to it.
 *
 * The ONLY voucher-specific logic in this module:
 *   - numbering uses the book's 'counters/gncExpVoucher' slot (GnuCash's
 *     dedicated voucher counter — bills use 'counters/gncBill'), with the
 *     same max-numeric-id fallback + counter bootstrap the engine uses;
 *   - list/get are restricted to owner_type=5 rows and re-typed as
 *     'voucher' so vouchers never mix into the invoice/bill lists
 *     (the engine's listInvoices intentionally excludes employee documents).
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import {
  createInvoice,
  updateInvoice,
  deleteInvoice,
  postInvoice,
  unpostInvoice,
  applyPayment,
  listPayments,
  buildInvoiceView,
  getInvoiceWithStatus,
  InvoiceNotFoundError,
  OWNER_TYPE_EMPLOYEE,
  type PrismaTx,
  type InvoiceView,
  type InvoiceDetailView,
  type InvoiceEntryInput,
  type PostInvoiceInput,
  type PostResult,
  type PaymentResult,
  type PaymentView,
} from './invoice-engine';
import { formatInvoiceId, nextIdFromExisting, type InvoiceStatus } from './invoice-totals';

/** GnuCash KVP slot types used by the counter frame. */
const SLOT_INT64 = 1;
const SLOT_FRAME = 9;

/** Book counter name GnuCash desktop uses for expense vouchers. */
export const VOUCHER_COUNTER = 'gncExpVoucher';

export type VoucherView = Omit<InvoiceView, 'type'> & { type: 'voucher' };
export type VoucherDetailView = Omit<InvoiceDetailView, 'type'> & { type: 'voucher' };

function asVoucher<T extends InvoiceView>(view: T): Omit<T, 'type'> & { type: 'voucher' } {
  return { ...view, type: 'voucher' as const };
}

/* ------------------------------------------------------------------ */
/* Numbering — 'counters/gncExpVoucher'                                 */
/* ------------------------------------------------------------------ */

/** Minimal structural DB surface so the counter logic is unit-testable. */
export interface VoucherCounterDb {
  slots: {
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<{ id: number; guid_val?: string | null; int64_val?: bigint | null } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>;
  };
  invoices: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Array<{ id: string }>>;
  };
}

/**
 * Next voucher number. Reads/increments the book's 'counters/gncExpVoucher'
 * slot (frame layout: book -> 'counters' frame -> child on the frame guid,
 * tolerating flat layouts); falls back to max-numeric-id + 1 across existing
 * vouchers and bootstraps the counter so desktop sees it. Zero-padded to 6.
 */
export async function nextVoucherId(db: VoucherCounterDb, bookGuid: string): Promise<string> {
  const frame = await db.slots.findFirst({
    where: { obj_guid: bookGuid, name: 'counters', slot_type: SLOT_FRAME },
  });
  let counterRow = frame?.guid_val
    ? await db.slots.findFirst({
        where: { obj_guid: frame.guid_val, name: `counters/${VOUCHER_COUNTER}` },
      })
    : null;
  if (!counterRow) {
    counterRow = await db.slots.findFirst({
      where: { obj_guid: bookGuid, name: `counters/${VOUCHER_COUNTER}` },
    });
  }

  if (counterRow) {
    // The stored value is the LAST used number; persist and use value + 1.
    const next = Number(counterRow.int64_val ?? 0n) + 1;
    await db.slots.update({ where: { id: counterRow.id }, data: { int64_val: BigInt(next) } });
    return formatInvoiceId(next);
  }

  const rows = await db.invoices.findMany({
    where: { owner_type: OWNER_TYPE_EMPLOYEE },
    select: { id: true },
  });
  const next = nextIdFromExisting(rows.map((r) => r.id));

  let frameGuid = frame?.guid_val ?? null;
  if (!frameGuid) {
    frameGuid = generateGuid();
    await db.slots.create({
      data: { obj_guid: bookGuid, name: 'counters', slot_type: SLOT_FRAME, guid_val: frameGuid },
    });
  }
  await db.slots.create({
    data: {
      obj_guid: frameGuid,
      name: `counters/${VOUCHER_COUNTER}`,
      slot_type: SLOT_INT64,
      int64_val: BigInt(next),
    },
  });

  return formatInvoiceId(next);
}

/* ------------------------------------------------------------------ */
/* Guards                                                               */
/* ------------------------------------------------------------------ */

async function assertVoucher(guid: string): Promise<void> {
  const row = await prisma.invoices.findUnique({
    where: { guid },
    select: { owner_type: true },
  });
  if (!row || row.owner_type !== OWNER_TYPE_EMPLOYEE) {
    throw new InvoiceNotFoundError(`Voucher not found: ${guid}`);
  }
}

/* ------------------------------------------------------------------ */
/* CRUD / post / pay — engine delegation                                */
/* ------------------------------------------------------------------ */

export interface CreateVoucherInput {
  employeeGuid: string;
  /** Explicit document number; omitted => next gncExpVoucher counter value. */
  id?: string;
  dateOpened?: string;
  notes?: string;
  billingId?: string;
  /** Expense line items (bill-style: no discounts). */
  entries: InvoiceEntryInput[];
  /** Active book guid (for the numbering counter). */
  bookGuid: string;
}

export async function createVoucher(input: CreateVoucherInput): Promise<VoucherDetailView> {
  const id = input.id?.trim()
    ? input.id.trim()
    : await nextVoucherId(prisma as unknown as VoucherCounterDb, input.bookGuid);
  const view = await createInvoice({
    ownerType: 'employee',
    ownerGuid: input.employeeGuid,
    id,
    dateOpened: input.dateOpened,
    notes: input.notes,
    billingId: input.billingId,
    entries: input.entries,
    bookGuid: input.bookGuid,
  });
  return asVoucher(view);
}

export interface UpdateVoucherInput {
  id?: string;
  dateOpened?: string;
  notes?: string;
  billingId?: string;
  active?: boolean;
  entries?: InvoiceEntryInput[];
}

export async function updateVoucher(guid: string, input: UpdateVoucherInput): Promise<VoucherDetailView> {
  await assertVoucher(guid);
  return asVoucher(await updateInvoice(guid, input));
}

export async function deleteVoucher(guid: string): Promise<void> {
  await assertVoucher(guid);
  await deleteInvoice(guid);
}

export async function getVoucher(guid: string): Promise<VoucherDetailView> {
  await assertVoucher(guid);
  return asVoucher(await getInvoiceWithStatus(guid));
}

/** Post to A/P: credit Accounts Payable, debit the expense accounts. */
export async function postVoucher(guid: string, input: PostInvoiceInput): Promise<PostResult> {
  await assertVoucher(guid);
  return postInvoice(guid, input);
}

export async function unpostVoucher(guid: string): Promise<void> {
  await assertVoucher(guid);
  return unpostInvoice(guid);
}

export interface PayVoucherInput {
  employeeGuid: string;
  /** Bank/asset account funding the reimbursement. */
  transferAccountGuid: string;
  amount: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  num?: string;
  memo?: string;
  /** Explicit allocation; omitted => oldest-first across open vouchers. */
  allocations?: Array<{ invoiceGuid: string; amount: number }>;
}

/** Reimburse the employee through the engine's lot-linked payment path. */
export async function payVouchers(input: PayVoucherInput): Promise<PaymentResult> {
  return applyPayment({
    ownerType: 'employee',
    ownerGuid: input.employeeGuid,
    transferAccountGuid: input.transferAccountGuid,
    amount: input.amount,
    date: input.date,
    num: input.num,
    memo: input.memo,
    allocations: input.allocations,
  });
}

export async function listVoucherPayments(employeeGuid: string): Promise<PaymentView[]> {
  return listPayments('employee', employeeGuid);
}

/* ------------------------------------------------------------------ */
/* Listing                                                              */
/* ------------------------------------------------------------------ */

export interface ListVouchersFilters {
  status?: InvoiceStatus;
  employeeGuid?: string;
  limit?: number;
  offset?: number;
}

export async function listVouchers(filters: ListVouchersFilters = {}): Promise<VoucherView[]> {
  const invoices = await prisma.invoices.findMany({
    where: {
      owner_type: OWNER_TYPE_EMPLOYEE,
      ...(filters.employeeGuid ? { owner_guid: filters.employeeGuid } : {}),
    },
    orderBy: [{ date_opened: 'desc' }],
  });

  const views: VoucherView[] = [];
  for (const inv of invoices) {
    try {
      const view = await buildInvoiceView(prisma as unknown as PrismaTx, inv, { includeEntries: false });
      views.push(asVoucher(view));
    } catch {
      // Skip vouchers whose employee row is missing (orphaned data)
      continue;
    }
  }

  let result = views;
  if (filters.status) {
    result = result.filter((v) => v.status === filters.status);
  }
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 100;
  return result.slice(offset, offset + limit);
}
