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
 *
 * A voucher IS an invoice row, so book scope resolves through the shared
 * 'invoice' ownership side table: every entry point takes the owning book as
 * its first argument and a foreign guid reads as not found.
 */

import prisma from '@/lib/prisma';
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
  nextCounterId,
  type CounterDb,
  type InvoiceView,
  type InvoiceDetailView,
  type InvoiceEntryInput,
  type PostInvoiceInput,
  type PostResult,
  type PaymentResult,
  type PaymentView,
} from './invoice-engine';
import { type InvoiceStatus } from './invoice-totals';
import { isEntityOwnedByBook, listOwnedEntityGuids } from './entity-ownership';

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

/**
 * Minimal structural DB surface so the counter logic is unit-testable.
 * $queryRaw is required for the atomic increment and the bootstrap advisory
 * lock — see nextCounterId in the invoice engine.
 */
export type VoucherCounterDb = CounterDb;

/**
 * Next voucher number. Atomically increments the book's
 * 'counters/gncExpVoucher' slot (frame layout: book -> 'counters' frame ->
 * child on the frame guid, tolerating flat layouts); falls back to
 * max-numeric-id + 1 across existing vouchers and bootstraps the counter so
 * desktop sees it (bootstrap serialized via advisory lock). Zero-padded to 6.
 * MUST run inside a $transaction — see createVoucher.
 */
export async function nextVoucherId(db: VoucherCounterDb, bookGuid: string): Promise<string> {
  return nextCounterId(db, bookGuid, VOUCHER_COUNTER, OWNER_TYPE_EMPLOYEE);
}

/* ------------------------------------------------------------------ */
/* Guards                                                               */
/* ------------------------------------------------------------------ */

async function assertVoucher(bookGuid: string, guid: string): Promise<void> {
  if (!(await isEntityOwnedByBook('invoice', guid, bookGuid))) {
    throw new InvoiceNotFoundError(`Voucher not found: ${guid}`);
  }
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
  // Counter increment + advisory-locked bootstrap need a transaction client
  // (pg_advisory_xact_lock is transaction-scoped); never run this on the bare
  // prisma client.
  const id = input.id?.trim()
    ? input.id.trim()
    : await prisma.$transaction((tx) =>
        nextVoucherId(tx as unknown as VoucherCounterDb, input.bookGuid),
      );
  const view = await createInvoice(input.bookGuid, {
    ownerType: 'employee',
    ownerGuid: input.employeeGuid,
    id,
    dateOpened: input.dateOpened,
    notes: input.notes,
    billingId: input.billingId,
    entries: input.entries,
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

export async function updateVoucher(
  bookGuid: string,
  guid: string,
  input: UpdateVoucherInput,
): Promise<VoucherDetailView> {
  await assertVoucher(bookGuid, guid);
  const view = await updateInvoice(bookGuid, guid, input);
  if (!view) throw new InvoiceNotFoundError(`Voucher not found: ${guid}`);
  return asVoucher(view);
}

export async function deleteVoucher(bookGuid: string, guid: string): Promise<void> {
  await assertVoucher(bookGuid, guid);
  const deleted = await deleteInvoice(bookGuid, guid);
  if (!deleted) throw new InvoiceNotFoundError(`Voucher not found: ${guid}`);
}

export async function getVoucher(bookGuid: string, guid: string): Promise<VoucherDetailView> {
  await assertVoucher(bookGuid, guid);
  const view = await getInvoiceWithStatus(bookGuid, guid);
  if (!view) throw new InvoiceNotFoundError(`Voucher not found: ${guid}`);
  return asVoucher(view);
}

/** Post to A/P: credit Accounts Payable, debit the expense accounts. */
export async function postVoucher(
  bookGuid: string,
  guid: string,
  input: PostInvoiceInput,
): Promise<PostResult> {
  await assertVoucher(bookGuid, guid);
  return postInvoice(bookGuid, guid, input);
}

export async function unpostVoucher(bookGuid: string, guid: string): Promise<void> {
  await assertVoucher(bookGuid, guid);
  return unpostInvoice(bookGuid, guid);
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
export async function payVouchers(
  bookGuid: string,
  input: PayVoucherInput,
): Promise<PaymentResult> {
  for (const allocation of input.allocations ?? []) {
    await assertVoucher(bookGuid, allocation.invoiceGuid);
  }
  return applyPayment(bookGuid, {
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

export async function listVoucherPayments(
  bookGuid: string,
  employeeGuid: string,
): Promise<PaymentView[]> {
  return listPayments(bookGuid, 'employee', employeeGuid);
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

export async function listVouchers(
  bookGuid: string,
  filters: ListVouchersFilters = {},
): Promise<VoucherView[]> {
  const ownedGuids = await listOwnedEntityGuids('invoice', bookGuid);
  // No ownership rows means the book owns no documents — never an unfiltered read.
  if (ownedGuids.length === 0) return [];

  const invoices = await prisma.invoices.findMany({
    where: {
      guid: { in: ownedGuids },
      owner_type: OWNER_TYPE_EMPLOYEE,
      ...(filters.employeeGuid ? { owner_guid: filters.employeeGuid } : {}),
    },
    orderBy: [{ date_opened: 'desc' }],
  });

  const views: VoucherView[] = [];
  for (const inv of invoices) {
    try {
      const view = await buildInvoiceView(bookGuid, inv.guid);
      if (view) views.push(asVoucher(view));
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
