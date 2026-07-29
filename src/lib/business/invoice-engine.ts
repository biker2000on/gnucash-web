/**
 * Invoice/Bill Posting Engine + Payments (AR/AP core)
 *
 * GnuCash-desktop-compatible engine for creating, posting, unposting and
 * paying invoices (customer, owner_type=2) and bills (vendor, owner_type=4),
 * including job-owned documents (owner_type=3 resolving to the job's owner).
 *
 * GnuCash-native structures written on POST (see gncInvoicePostToAccount):
 *   - transactions row: currency = invoice currency, num = invoice id,
 *     description = owner name, post_date = chosen date (noon UTC).
 *   - splits: +total on A/R for an invoice (-total on A/P for a bill), the
 *     opposite sign per line on income/expense accounts, and tax accumulated
 *     per tax account. The A/R–A/P split carries lot_guid.
 *   - lots row on the A/R–A/P account.
 *   - slots:
 *       lot:  'gncInvoice' frame (slot_type 9, guid_val = new frame guid F)
 *             + child row obj_guid=F, name='gncInvoice/invoice-guid',
 *               slot_type 5 (GUID), guid_val = invoice guid
 *       txn:  same 'gncInvoice' frame layout, plus
 *             'trans-txn-type'  (type 4 string) = 'I'   ('P' for payments)
 *             'trans-date-due'  (type 6 timespec) = due date
 *             'trans-read-only' (type 4 string) = unpost hint
 *             'date-posted'     (type 10 gdate) = post date
 *   - invoices row updated: date_posted, post_txn, post_acc, post_lot.
 *
 * Payments (see gncOwnerApplyPayment): one transaction, DEBIT deposit account
 * / CREDIT A/R for a customer payment (flipped for vendors); each A/R–A/P
 * split is assigned into the paid invoice's lot. A lot whose split values sum
 * to zero is fully paid (is_closed=1). Overpayments are rejected (no
 * pre-payment lot support).
 *
 * Numbering: reads/increments the book's 'counters/gncInvoice' or
 * 'counters/gncBill' slot (frame layout: book -> 'counters' frame ->
 * 'counters/<name>' int64 child). The stored counter is the LAST used number;
 * we store n+1 and use it, zero-padded to 6 digits (GnuCash "%.6" PRIi64).
 * Fallback when no counter exists: max numeric id of same-kind invoices + 1.
 *
 * Fractions: split values use the currency's fraction (100 for USD);
 * entry quantities and discounts use denom 100; entry prices use denom
 * 1,000,000 to preserve unit-price precision.
 *
 * All mutations run in a single prisma.$transaction.
 */

import prisma from '@/lib/prisma';
import { generateGuid, toDecimalNumber, fromDecimal, findOrCreateAccount } from '@/lib/gnucash';
import {
  assertNotLocked,
  getBookGuidForAccount,
  getBookGuidForRoot,
} from '@/lib/services/period-lock.service';
import {
  computeInvoiceTotals,
  buildPostingSplits,
  buildPaymentSplits,
  amountDueFromLotSplits,
  allocatePaymentFifo,
  computeDueDate,
  nextIdFromExisting,
  formatInvoiceId,
  invoiceStatus,
  roundCurrency,
  type EntryLineInput,
  type TaxTableSpec,
  type InvoiceKind,
  type InvoiceStatus,
  type BillTermSpec,
  type DiscountType,
  type DiscountHow,
} from './invoice-totals';

export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// GnuCash GncOwner type enum
export const OWNER_TYPE_CUSTOMER = 2;
export const OWNER_TYPE_JOB = 3;
export const OWNER_TYPE_VENDOR = 4;
export const OWNER_TYPE_EMPLOYEE = 5;

// GnuCash KVP slot types (KvpValue::Type)
const SLOT_INT64 = 1;
const SLOT_STRING = 4;
const SLOT_GUID = 5;
const SLOT_TIMESPEC = 6;
const SLOT_FRAME = 9;
const SLOT_GDATE = 10;

const QUANTITY_DENOM = 100;
const PRICE_DENOM = 1000000;
const DISCOUNT_DENOM = 100;

const TXN_READONLY_REASON = 'Generated from an invoice. Try unposting the invoice.';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Caller-fixable input problem — API routes map to HTTP 400. */
export class InvoiceValidationError extends Error {}
/** Missing entity — HTTP 404. */
export class InvoiceNotFoundError extends Error {}
/** Valid request but wrong document state (e.g. edit a posted invoice) — HTTP 409. */
export class InvoiceStateError extends Error {}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type OwnerTypeName = 'customer' | 'vendor' | 'job' | 'employee';

export interface InvoiceEntryInput {
  description?: string;
  action?: string;
  notes?: string;
  /** ISO date (YYYY-MM-DD); defaults to the invoice's dateOpened. */
  date?: string;
  quantity: number;
  price: number;
  accountGuid: string;
  /** Customer invoices only (bills have no discount columns in GnuCash). */
  discount?: number;
  discountType?: DiscountType;
  discountHow?: DiscountHow;
  taxable?: boolean;
  taxIncluded?: boolean;
  taxTableGuid?: string | null;
}

export interface CreateInvoiceInput {
  ownerType: OwnerTypeName;
  ownerGuid: string;
  /** Explicit document number; omitted => next counter value. */
  id?: string;
  /** ISO date; defaults to today. */
  dateOpened?: string;
  notes?: string;
  billingId?: string;
  termsGuid?: string | null;
  /** Defaults to the owner's currency. */
  currencyGuid?: string;
  entries: InvoiceEntryInput[];
  /** Active book guid (for the numbering counter). */
  bookGuid: string;
}

export interface UpdateInvoiceInput {
  id?: string;
  dateOpened?: string;
  notes?: string;
  billingId?: string;
  termsGuid?: string | null;
  currencyGuid?: string;
  active?: boolean;
  entries?: InvoiceEntryInput[];
}

export interface PostInvoiceInput {
  /** ISO date (YYYY-MM-DD). */
  postDate: string;
  /** ISO date; defaults to postDate + bill terms. */
  dueDate?: string;
  /** Memo written on the A/R–A/P split. */
  memo?: string;
  /** Transaction description override; defaults to the owner name. */
  description?: string;
  /** Book root (A/R–A/P account discovery/bootstrap scope). */
  bookRootGuid: string;
}

export interface ApplyPaymentInput {
  /** 'employee' pays expense vouchers (A/P side, like vendor bills). */
  ownerType: 'customer' | 'vendor' | 'employee';
  ownerGuid: string;
  /** Bank/asset account receiving (customer) or funding (vendor) the payment. */
  transferAccountGuid: string;
  amount: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Check/reference number. */
  num?: string;
  memo?: string;
  /** Caller-supplied stable GUID for idempotent provider/webhook posting. */
  transactionGuid?: string;
  /** Explicit allocation; omitted => oldest-first across open documents. */
  allocations?: Array<{ invoiceGuid: string; amount: number }>;
}

export interface EntryView {
  guid: string;
  date: string | null;
  description: string;
  action: string;
  notes: string;
  quantity: number;
  price: number;
  accountGuid: string | null;
  discount: number;
  discountType: DiscountType;
  discountHow: DiscountHow;
  taxable: boolean;
  taxIncluded: boolean;
  taxTableGuid: string | null;
  computed: {
    subtotal: number;
    discountValue: number;
    net: number;
    taxTotal: number;
    gross: number;
  };
}

export interface InvoiceView {
  guid: string;
  id: string;
  type: InvoiceKind;
  ownerType: OwnerTypeName;
  ownerGuid: string;
  ownerName: string;
  dateOpened: string | null;
  datePosted: string | null;
  dueDate: string | null;
  notes: string;
  billingId: string | null;
  termsGuid: string | null;
  currencyGuid: string;
  active: boolean;
  posted: boolean;
  postTxnGuid: string | null;
  postAccountGuid: string | null;
  postLotGuid: string | null;
  totals: { subtotal: number; discountTotal: number; taxTotal: number; total: number };
  amountDue: number;
  status: InvoiceStatus;
}

export interface InvoiceDetailView extends InvoiceView {
  entries: EntryView[];
}

export interface ListInvoicesFilters {
  type?: InvoiceKind;
  status?: InvoiceStatus;
  ownerGuid?: string;
  limit?: number;
  offset?: number;
}

export interface PostResult {
  transactionGuid: string;
  lotGuid: string;
  postAccountGuid: string;
  total: number;
  dueDate: string;
}

export interface PaymentResult {
  transactionGuid: string;
  allocations: Array<{ invoiceGuid: string; amount: number }>;
  fullyPaidInvoiceGuids: string[];
}

export interface PaymentView {
  transactionGuid: string;
  date: string | null;
  num: string;
  description: string;
  amount: number;
  allocations: Array<{ invoiceGuid: string; invoiceId: string; amount: number }>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseIsoDateNoon(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value ?? '')) {
    throw new InvoiceValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
  }
  const d = new Date(value.slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) {
    throw new InvoiceValidationError(`Invalid ${field}: '${value}'`);
  }
  return d;
}

function toIsoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

interface ResolvedOwner {
  /** End owner after job resolution: 2 (customer), 4 (vendor) or 5 (employee). */
  endType: typeof OWNER_TYPE_CUSTOMER | typeof OWNER_TYPE_VENDOR | typeof OWNER_TYPE_EMPLOYEE;
  endGuid: string;
  /** Direct owner as stored on the invoice (may be a job). */
  directType: number;
  directGuid: string;
  name: string;
  currencyGuid: string;
  termsGuid: string | null;
  kind: InvoiceKind;
}

async function resolveOwner(db: PrismaTx, ownerType: number, ownerGuid: string): Promise<ResolvedOwner> {
  if (ownerType === OWNER_TYPE_CUSTOMER) {
    const c = await db.customers.findUnique({ where: { guid: ownerGuid } });
    if (!c) throw new InvoiceNotFoundError(`Customer not found: ${ownerGuid}`);
    return {
      endType: OWNER_TYPE_CUSTOMER, endGuid: c.guid, directType: ownerType, directGuid: ownerGuid,
      name: c.name, currencyGuid: c.currency, termsGuid: c.terms ?? null, kind: 'invoice',
    };
  }
  if (ownerType === OWNER_TYPE_VENDOR) {
    const v = await db.vendors.findUnique({ where: { guid: ownerGuid } });
    if (!v) throw new InvoiceNotFoundError(`Vendor not found: ${ownerGuid}`);
    return {
      endType: OWNER_TYPE_VENDOR, endGuid: v.guid, directType: ownerType, directGuid: ownerGuid,
      name: v.name, currencyGuid: v.currency, termsGuid: v.terms ?? null, kind: 'bill',
    };
  }
  if (ownerType === OWNER_TYPE_EMPLOYEE) {
    // Employee-owned documents are EXPENSE VOUCHERS. They post exactly like
    // vendor bills (credit A/P, debit expense accounts, entries in the b_*
    // columns), so their kind is 'bill'. Employees carry no bill terms.
    const e = await db.employees.findUnique({ where: { guid: ownerGuid } });
    if (!e) throw new InvoiceNotFoundError(`Employee not found: ${ownerGuid}`);
    return {
      endType: OWNER_TYPE_EMPLOYEE, endGuid: e.guid, directType: ownerType, directGuid: ownerGuid,
      name: e.addr_name || e.username, currencyGuid: e.currency, termsGuid: null, kind: 'bill',
    };
  }
  if (ownerType === OWNER_TYPE_JOB) {
    const job = await db.jobs.findUnique({ where: { guid: ownerGuid } });
    if (!job) throw new InvoiceNotFoundError(`Job not found: ${ownerGuid}`);
    if (job.owner_type !== OWNER_TYPE_CUSTOMER && job.owner_type !== OWNER_TYPE_VENDOR) {
      throw new InvoiceValidationError(`Job ${ownerGuid} has unsupported owner type ${job.owner_type}`);
    }
    if (!job.owner_guid) {
      throw new InvoiceValidationError(`Job ${ownerGuid} has no owner`);
    }
    const parent = await resolveOwner(db, job.owner_type, job.owner_guid);
    return { ...parent, directType: OWNER_TYPE_JOB, directGuid: ownerGuid };
  }
  throw new InvoiceValidationError(`Unsupported owner type: ${ownerType}`);
}

function ownerTypeNameToInt(name: OwnerTypeName): number {
  if (name === 'customer') return OWNER_TYPE_CUSTOMER;
  if (name === 'vendor') return OWNER_TYPE_VENDOR;
  if (name === 'job') return OWNER_TYPE_JOB;
  if (name === 'employee') return OWNER_TYPE_EMPLOYEE;
  throw new InvoiceValidationError(`Unsupported owner type: ${name}`);
}

function ownerTypeIntToName(t: number): OwnerTypeName {
  if (t === OWNER_TYPE_CUSTOMER) return 'customer';
  if (t === OWNER_TYPE_VENDOR) return 'vendor';
  if (t === OWNER_TYPE_JOB) return 'job';
  if (t === OWNER_TYPE_EMPLOYEE) return 'employee';
  return 'customer';
}

/**
 * Write a GUID value inside a KVP frame, matching GnuCash's SQL slot layout:
 * frame row (slot_type 9, guid_val = generated frame guid F) on the object,
 * child row obj_guid=F with the full '/'-joined path name.
 */
async function writeGuidFrameSlot(
  db: PrismaTx,
  objGuid: string,
  frameName: string,
  key: string,
  guidVal: string,
): Promise<void> {
  const frameGuid = generateGuid();
  await db.slots.create({
    data: { obj_guid: objGuid, name: frameName, slot_type: SLOT_FRAME, guid_val: frameGuid },
  });
  await db.slots.create({
    data: { obj_guid: frameGuid, name: `${frameName}/${key}`, slot_type: SLOT_GUID, guid_val: guidVal },
  });
}

/** Delete an object's slots, descending into frame children (guid_val). */
async function deleteSlotsRecursive(db: PrismaTx, objGuid: string): Promise<void> {
  const rows = await db.slots.findMany({ where: { obj_guid: objGuid } });
  for (const r of rows) {
    if (r.slot_type === SLOT_FRAME && r.guid_val) {
      await deleteSlotsRecursive(db, r.guid_val);
    }
  }
  await db.slots.deleteMany({ where: { obj_guid: objGuid } });
}

async function getCurrencyFraction(db: PrismaTx, currencyGuid: string): Promise<number> {
  const c = await db.commodities.findUnique({
    where: { guid: currencyGuid },
    select: { fraction: true, namespace: true },
  });
  if (!c) throw new InvoiceValidationError(`Currency not found: ${currencyGuid}`);
  return c.fraction || 100;
}

/**
 * Next document number. Reads/increments the book's counter slot
 * ('counters/gncInvoice' or 'counters/gncBill'); falls back to
 * max-numeric-id + 1 across same-kind invoices. Zero-padded to 6 digits.
 */
async function nextInvoiceId(
  db: PrismaTx,
  bookGuid: string,
  kind: InvoiceKind,
): Promise<string> {
  const counterName = kind === 'invoice' ? 'gncInvoice' : 'gncBill';

  // GnuCash frame layout: book -> 'counters' frame -> child on the frame guid
  const frame = await db.slots.findFirst({
    where: { obj_guid: bookGuid, name: 'counters', slot_type: SLOT_FRAME },
  });
  let counterRow = frame?.guid_val
    ? await db.slots.findFirst({
        where: { obj_guid: frame.guid_val, name: `counters/${counterName}` },
      })
    : null;
  if (!counterRow) {
    // Tolerate flat layouts (obj_guid = book guid, full-path name)
    counterRow = await db.slots.findFirst({
      where: { obj_guid: bookGuid, name: `counters/${counterName}` },
    });
  }

  if (counterRow) {
    // Stored value is the LAST used number; next = value + 1, persist it.
    const next = Number(counterRow.int64_val ?? 0n) + 1;
    await db.slots.update({ where: { id: counterRow.id }, data: { int64_val: BigInt(next) } });
    return formatInvoiceId(next);
  }

  // Fallback: max numeric id among same-kind documents (job-owned ignored),
  // then persist a GnuCash-style counter so future numbering is stable and
  // desktop sees the counter.
  const ownerType = kind === 'invoice' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR;
  const rows = await db.invoices.findMany({
    where: { owner_type: ownerType },
    select: { id: true },
  });
  const next = nextIdFromExisting(rows.map((r: { id: string }) => r.id));

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
      name: `counters/${counterName}`,
      slot_type: SLOT_INT64,
      int64_val: BigInt(next),
    },
  });

  return formatInvoiceId(next);
}

/**
 * Find an A/R (invoice) or A/P (bill) account under the book root, preferring
 * a currency match; bootstrap 'Accounts Receivable'/'Accounts Payable' under
 * the root when none exists.
 */
async function findOrCreatePostAccount(
  db: PrismaTx,
  kind: InvoiceKind,
  bookRootGuid: string,
  currencyGuid: string,
): Promise<string> {
  const accountType = kind === 'invoice' ? 'RECEIVABLE' : 'PAYABLE';

  const allAccounts: Array<{
    guid: string;
    parent_guid: string | null;
    account_type: string;
    commodity_guid: string | null;
    placeholder: number | null;
  }> = await db.accounts.findMany({
    select: {
      guid: true,
      parent_guid: true,
      account_type: true,
      commodity_guid: true,
      placeholder: true,
    },
  });
  const byGuid = new Map(allAccounts.map((a) => [a.guid, a]));
  const underRoot = (guid: string): boolean => {
    let cur = byGuid.get(guid) ?? null;
    for (let i = 0; i < 25 && cur; i++) {
      if (cur.guid === bookRootGuid) return true;
      cur = cur.parent_guid ? (byGuid.get(cur.parent_guid) ?? null) : null;
    }
    return false;
  };

  const candidates = allAccounts.filter(
    (a) => a.account_type === accountType && a.placeholder !== 1 && underRoot(a.guid),
  );
  // Prefer currency match; deterministic tiebreak by guid.
  candidates.sort((a, b) => {
    const am = a.commodity_guid === currencyGuid ? 0 : 1;
    const bm = b.commodity_guid === currencyGuid ? 0 : 1;
    if (am !== bm) return am - bm;
    return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
  });
  // Use a matching-currency account when available; otherwise bootstrap a
  // fresh A/R–A/P account in the invoice currency (a different-currency
  // account cannot carry these splits without conversion).
  if (candidates.length > 0 && candidates[0].commodity_guid === currencyGuid) {
    return candidates[0].guid;
  }

  const name = kind === 'invoice' ? 'Accounts Receivable' : 'Accounts Payable';
  const guid = await findOrCreateAccount(name, bookRootGuid, currencyGuid, db);
  // findOrCreateAccount creates INCOME-typed leaves — coerce to the A/R–A/P type.
  await db.accounts.update({
    where: { guid },
    data: { account_type: accountType, placeholder: 0, description: name },
  });
  return guid;
}

// ---------------------------------------------------------------------------
// Entry row <-> line conversion
// ---------------------------------------------------------------------------

type EntryRow = {
  guid: string;
  date: Date;
  description: string | null;
  action: string | null;
  notes: string | null;
  quantity_num: bigint | null;
  quantity_denom: bigint | null;
  i_acct: string | null;
  i_price_num: bigint | null;
  i_price_denom: bigint | null;
  i_discount_num: bigint | null;
  i_discount_denom: bigint | null;
  invoice: string | null;
  i_disc_type: string | null;
  i_disc_how: string | null;
  i_taxable: number | null;
  i_taxincluded: number | null;
  i_taxtable: string | null;
  b_acct: string | null;
  b_price_num: bigint | null;
  b_price_denom: bigint | null;
  bill: string | null;
  b_taxable: number | null;
  b_taxincluded: number | null;
  b_taxtable: string | null;
};

function entryRowToLine(
  row: EntryRow,
  kind: InvoiceKind,
  taxTables: Map<string, TaxTableSpec>,
): EntryLineInput {
  const quantity = toDecimalNumber(row.quantity_num, row.quantity_denom);
  if (kind === 'invoice') {
    const taxTableGuid = row.i_taxtable ?? null;
    return {
      accountGuid: row.i_acct ?? '',
      description: row.description ?? '',
      quantity,
      price: toDecimalNumber(row.i_price_num, row.i_price_denom),
      discount: toDecimalNumber(row.i_discount_num, row.i_discount_denom),
      discountType: (row.i_disc_type as DiscountType) || 'VALUE',
      discountHow: (row.i_disc_how as DiscountHow) || 'PRETAX',
      taxable: row.i_taxable === 1,
      taxIncluded: row.i_taxincluded === 1,
      taxTable: taxTableGuid ? (taxTables.get(taxTableGuid) ?? null) : null,
    };
  }
  const taxTableGuid = row.b_taxtable ?? null;
  return {
    accountGuid: row.b_acct ?? '',
    description: row.description ?? '',
    quantity,
    price: toDecimalNumber(row.b_price_num, row.b_price_denom),
    discount: 0,
    taxable: row.b_taxable === 1,
    taxIncluded: row.b_taxincluded === 1,
    taxTable: taxTableGuid ? (taxTables.get(taxTableGuid) ?? null) : null,
  };
}

async function loadTaxTables(db: PrismaTx, guids: string[]): Promise<Map<string, TaxTableSpec>> {
  const map = new Map<string, TaxTableSpec>();
  const unique = Array.from(new Set(guids.filter(Boolean)));
  if (unique.length === 0) return map;
  const rows: Array<{ taxtable: string; account: string; amount_num: bigint; amount_denom: bigint; type: number }> =
    await db.taxtable_entries.findMany({ where: { taxtable: { in: unique } } });
  for (const guid of unique) map.set(guid, { guid, entries: [] });
  for (const r of rows) {
    map.get(r.taxtable)?.entries.push({
      accountGuid: r.account,
      // GNC_AMT_TYPE_VALUE = 1, GNC_AMT_TYPE_PERCENT = 2
      type: r.type === 2 ? 'PERCENT' : 'VALUE',
      amount: toDecimalNumber(r.amount_num, r.amount_denom),
    });
  }
  return map;
}

async function validateEntries(
  db: PrismaTx,
  kind: InvoiceKind,
  entries: InvoiceEntryInput[],
): Promise<void> {
  if (!entries || entries.length === 0) {
    throw new InvoiceValidationError('At least one entry is required');
  }
  for (const e of entries) {
    if (!e.accountGuid) throw new InvoiceValidationError('Entry accountGuid is required');
    if (typeof e.quantity !== 'number' || !isFinite(e.quantity)) {
      throw new InvoiceValidationError('Entry quantity must be a finite number');
    }
    if (typeof e.price !== 'number' || !isFinite(e.price)) {
      throw new InvoiceValidationError('Entry price must be a finite number');
    }
    if (kind === 'bill' && e.discount) {
      throw new InvoiceValidationError('Discounts are not supported on bills (GnuCash bill entries have no discount)');
    }
    if (e.discountType && !['VALUE', 'PERCENT'].includes(e.discountType)) {
      throw new InvoiceValidationError(`Invalid discountType: ${e.discountType}`);
    }
    if (e.discountHow && !['PRETAX', 'SAMETIME', 'POSTTAX'].includes(e.discountHow)) {
      throw new InvoiceValidationError(`Invalid discountHow: ${e.discountHow}`);
    }
  }
  const accountGuids = Array.from(new Set(entries.map((e) => e.accountGuid)));
  const accounts = await db.accounts.findMany({
    where: { guid: { in: accountGuids } },
    select: { guid: true },
  });
  const found = new Set(accounts.map((a: { guid: string }) => a.guid));
  const missing = accountGuids.filter((g) => !found.has(g));
  if (missing.length > 0) {
    throw new InvoiceValidationError(`Entry account(s) not found: ${missing.join(', ')}`);
  }
  const taxTableGuids = Array.from(new Set(entries.map((e) => e.taxTableGuid).filter((g): g is string => Boolean(g))));
  if (taxTableGuids.length > 0) {
    const tables = await db.taxtables.findMany({
      where: { guid: { in: taxTableGuids } },
      select: { guid: true },
    });
    const foundTt = new Set(tables.map((t: { guid: string }) => t.guid));
    const missingTt = taxTableGuids.filter((g) => !foundTt.has(g));
    if (missingTt.length > 0) {
      throw new InvoiceValidationError(`Tax table(s) not found: ${missingTt.join(', ')}`);
    }
  }
}

async function createEntryRows(
  db: PrismaTx,
  invoiceGuid: string,
  kind: InvoiceKind,
  entries: InvoiceEntryInput[],
  defaultDate: Date,
): Promise<void> {
  const now = new Date();
  for (const e of entries) {
    const qty = fromDecimal(e.quantity, QUANTITY_DENOM);
    const price = fromDecimal(e.price, PRICE_DENOM);
    const common = {
      guid: generateGuid(),
      date: e.date ? parseIsoDateNoon(e.date, 'entry date') : defaultDate,
      date_entered: now,
      description: e.description ?? '',
      action: e.action ?? '',
      notes: e.notes ?? '',
      quantity_num: qty.num,
      quantity_denom: qty.denom,
    };
    if (kind === 'invoice') {
      const disc = fromDecimal(e.discount ?? 0, DISCOUNT_DENOM);
      await db.entries.create({
        data: {
          ...common,
          invoice: invoiceGuid,
          i_acct: e.accountGuid,
          i_price_num: price.num,
          i_price_denom: price.denom,
          i_discount_num: disc.num,
          i_discount_denom: disc.denom,
          i_disc_type: e.discountType ?? 'VALUE',
          i_disc_how: e.discountHow ?? 'PRETAX',
          i_taxable: e.taxable === false ? 0 : 1,
          i_taxincluded: e.taxIncluded ? 1 : 0,
          i_taxtable: e.taxTableGuid ?? null,
        },
      });
    } else {
      await db.entries.create({
        data: {
          ...common,
          bill: invoiceGuid,
          b_acct: e.accountGuid,
          b_price_num: price.num,
          b_price_denom: price.denom,
          b_taxable: e.taxable === false ? 0 : 1,
          b_taxincluded: e.taxIncluded ? 1 : 0,
          b_taxtable: e.taxTableGuid ?? null,
          b_paytype: 1, // GNC_PAYMENT_CASH default
          billable: 0,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// createInvoice / updateInvoice / deleteInvoice
// ---------------------------------------------------------------------------

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceDetailView> {
  const guid = generateGuid();
  await prisma.$transaction(async (tx) => {
    const ownerTypeInt = ownerTypeNameToInt(input.ownerType);
    const owner = await resolveOwner(tx, ownerTypeInt, input.ownerGuid);
    const kind = owner.kind;

    await validateEntries(tx, kind, input.entries);

    const currencyGuid = input.currencyGuid ?? owner.currencyGuid;
    await getCurrencyFraction(tx, currencyGuid); // validates existence

    if (input.termsGuid) {
      const term = await tx.billterms.findUnique({ where: { guid: input.termsGuid }, select: { guid: true } });
      if (!term) throw new InvoiceValidationError(`Bill term not found: ${input.termsGuid}`);
    }

    const dateOpened = input.dateOpened
      ? parseIsoDateNoon(input.dateOpened, 'dateOpened')
      : new Date();
    const id = input.id?.trim()
      ? input.id.trim()
      : await nextInvoiceId(tx, input.bookGuid, kind);

    await tx.invoices.create({
      data: {
        guid,
        id,
        date_opened: dateOpened,
        date_posted: null,
        notes: input.notes ?? '',
        active: 1,
        currency: currencyGuid,
        owner_type: ownerTypeInt,
        owner_guid: input.ownerGuid,
        terms: input.termsGuid ?? owner.termsGuid ?? null,
        billing_id: input.billingId ?? '',
        post_txn: null,
        post_lot: null,
        post_acc: null,
        billto_type: null,
        billto_guid: null,
        charge_amt_num: 0n,
        charge_amt_denom: 1n,
      },
    });

    await createEntryRows(tx, guid, kind, input.entries, dateOpened);
  });

  return getInvoiceWithStatus(guid);
}

export async function updateInvoice(guid: string, input: UpdateInvoiceInput): Promise<InvoiceDetailView> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    if (invoice.post_txn) {
      throw new InvoiceStateError('Cannot edit a posted invoice — unpost it first');
    }
    const owner = await resolveOwner(tx, invoice.owner_type ?? 0, invoice.owner_guid ?? '');
    const kind = owner.kind;

    const currencyGuid = input.currencyGuid ?? invoice.currency;
    await getCurrencyFraction(tx, currencyGuid);
    if (input.termsGuid) {
      const term = await tx.billterms.findUnique({ where: { guid: input.termsGuid }, select: { guid: true } });
      if (!term) throw new InvoiceValidationError(`Bill term not found: ${input.termsGuid}`);
    }

    const dateOpened = input.dateOpened
      ? parseIsoDateNoon(input.dateOpened, 'dateOpened')
      : invoice.date_opened;

    await tx.invoices.update({
      where: { guid },
      data: {
        id: input.id?.trim() ? input.id.trim() : invoice.id,
        date_opened: dateOpened,
        notes: input.notes ?? invoice.notes,
        billing_id: input.billingId ?? invoice.billing_id,
        terms: input.termsGuid !== undefined ? input.termsGuid : invoice.terms,
        currency: currencyGuid,
        active: input.active !== undefined ? (input.active ? 1 : 0) : invoice.active,
      },
    });

    if (input.entries) {
      await validateEntries(tx, kind, input.entries);
      await tx.entries.deleteMany({
        where: kind === 'invoice' ? { invoice: guid } : { bill: guid },
      });
      await createEntryRows(tx, guid, kind, input.entries, dateOpened ?? new Date());
    }
  });

  return getInvoiceWithStatus(guid);
}

export async function deleteInvoice(guid: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    if (invoice.post_txn) {
      throw new InvoiceStateError('Cannot delete a posted invoice — unpost it first');
    }
    await tx.entries.deleteMany({ where: { OR: [{ invoice: guid }, { bill: guid }] } });
    await deleteSlotsRecursive(tx, guid);
    await tx.invoices.delete({ where: { guid } });
  });
}

// ---------------------------------------------------------------------------
// postInvoice / unpostInvoice
// ---------------------------------------------------------------------------

export async function postInvoice(guid: string, input: PostInvoiceInput): Promise<PostResult> {
  let result: PostResult | null = null;

  // Period lock: posting creates the A/R–A/P transaction at postDate
  const lockBookGuid = await getBookGuidForRoot(input.bookRootGuid);
  if (lockBookGuid) await assertNotLocked(lockBookGuid, [input.postDate]);

  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    if (invoice.post_txn) throw new InvoiceStateError('Invoice is already posted');

    const owner = await resolveOwner(tx, invoice.owner_type ?? 0, invoice.owner_guid ?? '');
    const kind = owner.kind;

    const entryRows: EntryRow[] = await tx.entries.findMany({
      where: kind === 'invoice' ? { invoice: guid } : { bill: guid },
      orderBy: { date: 'asc' },
    });
    if (entryRows.length === 0) {
      throw new InvoiceValidationError('Cannot post an invoice with no entries');
    }

    const taxTableGuids = entryRows
      .map((r) => (kind === 'invoice' ? r.i_taxtable : r.b_taxtable))
      .filter((g): g is string => Boolean(g));
    const taxTables = await loadTaxTables(tx, taxTableGuids);
    const lines = entryRows.map((r) => entryRowToLine(r, kind, taxTables));

    const fraction = await getCurrencyFraction(tx, invoice.currency);
    const totals = computeInvoiceTotals(lines, fraction);
    if (totals.total === 0) {
      throw new InvoiceValidationError('Cannot post an invoice with a zero total');
    }

    const postDate = parseIsoDateNoon(input.postDate, 'postDate');

    // Due date: explicit > bill terms > post date
    let dueDate: Date;
    if (input.dueDate) {
      dueDate = parseIsoDateNoon(input.dueDate, 'dueDate');
    } else {
      let term: BillTermSpec | null = null;
      if (invoice.terms) {
        const t = await tx.billterms.findUnique({ where: { guid: invoice.terms } });
        if (t) term = { type: t.type, duedays: t.duedays, cutoff: t.cutoff };
      }
      dueDate = computeDueDate(postDate, term);
    }

    // A/R–A/P account
    const postAccountGuid = await findOrCreatePostAccount(tx, kind, input.bookRootGuid, invoice.currency);

    // Lot on the A/R–A/P account, tagged with the invoice guid
    const lotGuid = generateGuid();
    await tx.lots.create({ data: { guid: lotGuid, account_guid: postAccountGuid, is_closed: 0 } });
    await writeGuidFrameSlot(tx, lotGuid, 'gncInvoice', 'invoice-guid', guid);

    // Posting transaction
    const txnGuid = generateGuid();
    const now = new Date();
    await tx.transactions.create({
      data: {
        guid: txnGuid,
        currency_guid: invoice.currency,
        num: invoice.id,
        post_date: postDate,
        enter_date: now,
        description: input.description ?? owner.name,
      },
    });
    await writeGuidFrameSlot(tx, txnGuid, 'gncInvoice', 'invoice-guid', guid);
    await tx.slots.create({
      data: { obj_guid: txnGuid, name: 'trans-txn-type', slot_type: SLOT_STRING, string_val: 'I' },
    });
    await tx.slots.create({
      data: { obj_guid: txnGuid, name: 'trans-date-due', slot_type: SLOT_TIMESPEC, timespec_val: dueDate },
    });
    await tx.slots.create({
      data: { obj_guid: txnGuid, name: 'trans-read-only', slot_type: SLOT_STRING, string_val: TXN_READONLY_REASON },
    });
    await tx.slots.create({
      data: {
        obj_guid: txnGuid,
        name: 'date-posted',
        slot_type: SLOT_GDATE,
        gdate_val: new Date(input.postDate.slice(0, 10) + 'T00:00:00Z'),
      },
    });

    // Splits
    const splitSpecs = buildPostingSplits(kind, totals, lines, postAccountGuid, input.memo ?? '');
    for (const spec of splitSpecs) {
      const frac = fromDecimal(spec.value, fraction);
      await tx.splits.create({
        data: {
          guid: generateGuid(),
          tx_guid: txnGuid,
          account_guid: spec.accountGuid,
          memo: spec.memo,
          action: spec.action,
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: frac.num,
          value_denom: frac.denom,
          quantity_num: frac.num,
          quantity_denom: frac.denom,
          lot_guid: spec.isPostSplit ? lotGuid : null,
        },
      });
    }

    // Mark the invoice posted
    await tx.invoices.update({
      where: { guid },
      data: {
        date_posted: postDate,
        post_txn: txnGuid,
        post_acc: postAccountGuid,
        post_lot: lotGuid,
      },
    });

    result = {
      transactionGuid: txnGuid,
      lotGuid,
      postAccountGuid,
      total: totals.total,
      dueDate: dueDate.toISOString().slice(0, 10),
    };
  });

  return result!;
}

export async function unpostInvoice(guid: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    if (!invoice.post_txn) throw new InvoiceStateError('Invoice is not posted');

    // Period lock: unposting deletes the posting transaction
    if (invoice.post_acc) {
      const lockBookGuid = await getBookGuidForAccount(invoice.post_acc);
      if (lockBookGuid) {
        const postingTxn = await tx.transactions.findUnique({
          where: { guid: invoice.post_txn },
          select: { post_date: true },
        });
        await assertNotLocked(lockBookGuid, [postingTxn?.post_date]);
      }
    }

    // Refuse when payments are attached to the lot
    if (invoice.post_lot) {
      const lotSplits = await tx.splits.findMany({
        where: { lot_guid: invoice.post_lot },
        select: { guid: true, tx_guid: true },
      });
      const foreign = lotSplits.filter((s: { tx_guid: string }) => s.tx_guid !== invoice.post_txn);
      if (foreign.length > 0) {
        throw new InvoiceStateError(
          'Cannot unpost: payments are applied to this invoice. Remove the payment transactions first.',
        );
      }
    }

    // Delete the posting transaction, its splits, and all their slots
    const splits = await tx.splits.findMany({
      where: { tx_guid: invoice.post_txn },
      select: { guid: true },
    });
    for (const s of splits) {
      await deleteSlotsRecursive(tx, s.guid);
    }
    await tx.splits.deleteMany({ where: { tx_guid: invoice.post_txn } });
    await deleteSlotsRecursive(tx, invoice.post_txn);
    await tx.transactions.delete({ where: { guid: invoice.post_txn } });

    // Delete the lot and its slots
    if (invoice.post_lot) {
      await deleteSlotsRecursive(tx, invoice.post_lot);
      await tx.lots.delete({ where: { guid: invoice.post_lot } });
    }

    await tx.invoices.update({
      where: { guid },
      data: { date_posted: null, post_txn: null, post_acc: null, post_lot: null },
    });
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

interface OpenDocument {
  guid: string;
  id: string;
  kind: InvoiceKind;
  datePosted: Date | null;
  postLot: string;
  postAcc: string;
  currency: string;
  amountDue: number;
}

/** Posted, not fully paid documents for an owner (jobs of the owner included). */
async function loadOpenDocuments(
  db: PrismaTx,
  endOwnerType: number,
  ownerGuid: string,
  kind: InvoiceKind,
): Promise<OpenDocument[]> {
  const jobs: Array<{ guid: string }> = await db.jobs.findMany({
    where: { owner_type: endOwnerType, owner_guid: ownerGuid },
    select: { guid: true },
  });
  const jobGuids = jobs.map((j) => j.guid);

  const invoices = await db.invoices.findMany({
    where: {
      post_txn: { not: null },
      OR: [
        { owner_type: endOwnerType, owner_guid: ownerGuid },
        ...(jobGuids.length > 0 ? [{ owner_type: OWNER_TYPE_JOB, owner_guid: { in: jobGuids } }] : []),
      ],
    },
  });
  if (invoices.length === 0) return [];

  const lotGuids = invoices.map((i: { post_lot: string | null }) => i.post_lot).filter((g: string | null): g is string => Boolean(g));
  const lotSplits: Array<{ lot_guid: string | null; value_num: bigint; value_denom: bigint }> =
    await db.splits.findMany({
      where: { lot_guid: { in: lotGuids } },
      select: { lot_guid: true, value_num: true, value_denom: true },
    });
  const valuesByLot = new Map<string, number[]>();
  for (const s of lotSplits) {
    if (!s.lot_guid) continue;
    const arr = valuesByLot.get(s.lot_guid) ?? [];
    arr.push(toDecimalNumber(s.value_num, s.value_denom));
    valuesByLot.set(s.lot_guid, arr);
  }

  const docs: OpenDocument[] = [];
  for (const inv of invoices) {
    if (!inv.post_lot || !inv.post_acc) continue;
    const due = amountDueFromLotSplits(kind, valuesByLot.get(inv.post_lot) ?? []);
    docs.push({
      guid: inv.guid,
      id: inv.id,
      kind,
      datePosted: inv.date_posted,
      postLot: inv.post_lot,
      postAcc: inv.post_acc,
      currency: inv.currency,
      amountDue: due,
    });
  }
  return docs;
}

export async function applyPayment(input: ApplyPaymentInput): Promise<PaymentResult> {
  if (!(input.amount > 0)) {
    throw new InvoiceValidationError('Payment amount must be positive');
  }
  const postDate = parseIsoDateNoon(input.date, 'date');

  if (input.transactionGuid) {
    const existing = await prisma.transactions.findUnique({
      where: { guid: input.transactionGuid },
      select: { guid: true },
    });
    if (existing) {
      return {
        transactionGuid: existing.guid,
        allocations: input.allocations ?? [],
        fullyPaidInvoiceGuids: [],
      };
    }
  }

  // Period lock: payments create a transaction dated input.date
  const lockBookGuid = await getBookGuidForAccount(input.transferAccountGuid);
  if (lockBookGuid) await assertNotLocked(lockBookGuid, [postDate]);

  let result: PaymentResult | null = null;

  await prisma.$transaction(async (tx) => {
    const endOwnerType = ownerTypeNameToInt(input.ownerType);
    const owner = await resolveOwner(tx, endOwnerType, input.ownerGuid);
    const kind: InvoiceKind = owner.kind;

    const transferAccount = await tx.accounts.findUnique({
      where: { guid: input.transferAccountGuid },
      select: { guid: true, placeholder: true },
    });
    if (!transferAccount) {
      throw new InvoiceNotFoundError(`Transfer account not found: ${input.transferAccountGuid}`);
    }
    if (transferAccount.placeholder === 1) {
      throw new InvoiceValidationError('Transfer account is a placeholder');
    }

    const fraction = await getCurrencyFraction(tx, owner.currencyGuid);
    const amount = roundCurrency(input.amount, fraction);
    const epsilon = 0.5 / fraction;

    const openDocs = await loadOpenDocuments(tx, endOwnerType, input.ownerGuid, kind);
    const openByGuid = new Map(openDocs.map((d) => [d.guid, d]));

    // Determine allocations
    let allocations: Array<{ invoiceGuid: string; amount: number }>;
    if (input.allocations && input.allocations.length > 0) {
      for (const a of input.allocations) {
        const doc = openByGuid.get(a.invoiceGuid);
        if (!doc) {
          throw new InvoiceValidationError(
            `Invoice ${a.invoiceGuid} is not an open posted document for this owner`,
          );
        }
        if (!(a.amount > 0)) {
          throw new InvoiceValidationError('Allocation amounts must be positive');
        }
        if (a.amount > doc.amountDue + epsilon) {
          throw new InvoiceValidationError(
            `Allocation ${a.amount} exceeds amount due ${doc.amountDue} on invoice ${doc.id}`,
          );
        }
        if (doc.currency !== owner.currencyGuid) {
          throw new InvoiceValidationError(
            `Invoice ${doc.id} currency differs from the owner currency — multi-currency payments are not supported`,
          );
        }
      }
      const guids = input.allocations.map((a) => a.invoiceGuid);
      if (new Set(guids).size !== guids.length) {
        throw new InvoiceValidationError('Duplicate invoice in allocations');
      }
      const sum = roundCurrency(
        input.allocations.reduce((s, a) => s + a.amount, 0),
        fraction,
      );
      if (Math.abs(sum - amount) > epsilon) {
        throw new InvoiceValidationError(
          `Allocation total ${sum} does not equal payment amount ${amount}`,
        );
      }
      allocations = input.allocations.map((a) => ({
        invoiceGuid: a.invoiceGuid,
        amount: roundCurrency(a.amount, fraction),
      }));
    } else {
      const sameCurrency = openDocs.filter((d) => d.currency === owner.currencyGuid);
      const fifo = allocatePaymentFifo(
        sameCurrency.map((d) => ({ guid: d.guid, datePosted: d.datePosted, amountDue: d.amountDue })),
        amount,
        fraction,
      );
      if (fifo.remainder > epsilon) {
        throw new InvoiceValidationError(
          `Payment of ${amount} exceeds the total amount due (${roundCurrency(amount - fifo.remainder, fraction)}). ` +
            'Overpayments (pre-payment credits) are not supported.',
        );
      }
      if (fifo.allocations.length === 0) {
        throw new InvoiceValidationError('No open posted invoices to apply the payment to');
      }
      allocations = fifo.allocations;
    }

    // Build the payment transaction
    const txnGuid = input.transactionGuid ?? generateGuid();
    await tx.transactions.create({
      data: {
        guid: txnGuid,
        currency_guid: owner.currencyGuid,
        num: input.num ?? '',
        post_date: postDate,
        enter_date: new Date(),
        description: owner.name,
      },
    });
    await tx.slots.create({
      data: { obj_guid: txnGuid, name: 'trans-txn-type', slot_type: SLOT_STRING, string_val: 'P' },
    });
    await tx.slots.create({
      data: {
        obj_guid: txnGuid,
        name: 'date-posted',
        slot_type: SLOT_GDATE,
        gdate_val: new Date(input.date.slice(0, 10) + 'T00:00:00Z'),
      },
    });

    const splitSpecs = buildPaymentSplits(
      kind,
      amount,
      input.transferAccountGuid,
      allocations.map((a) => {
        const doc = openByGuid.get(a.invoiceGuid)!;
        return { accountGuid: doc.postAcc, lotGuid: doc.postLot, amount: a.amount };
      }),
      input.memo ?? '',
    );
    for (const spec of splitSpecs) {
      const frac = fromDecimal(spec.value, fraction);
      await tx.splits.create({
        data: {
          guid: generateGuid(),
          tx_guid: txnGuid,
          account_guid: spec.accountGuid,
          memo: spec.memo,
          action: spec.action,
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: frac.num,
          value_denom: frac.denom,
          quantity_num: frac.num,
          quantity_denom: frac.denom,
          lot_guid: spec.lotGuid,
        },
      });
    }

    // Close fully-paid lots
    const fullyPaid: string[] = [];
    for (const a of allocations) {
      const doc = openByGuid.get(a.invoiceGuid)!;
      if (Math.abs(doc.amountDue - a.amount) <= epsilon) {
        await tx.lots.update({ where: { guid: doc.postLot }, data: { is_closed: 1 } });
        fullyPaid.push(a.invoiceGuid);
      }
    }

    result = { transactionGuid: txnGuid, allocations, fullyPaidInvoiceGuids: fullyPaid };
  });

  return result!;
}

export async function listPayments(
  ownerType: 'customer' | 'vendor' | 'employee',
  ownerGuid: string,
): Promise<PaymentView[]> {
  const endOwnerType = ownerTypeNameToInt(ownerType);
  const owner = await resolveOwner(prisma as unknown as PrismaTx, endOwnerType, ownerGuid);
  const kind = owner.kind;

  const jobs = await prisma.jobs.findMany({
    where: { owner_type: endOwnerType, owner_guid: ownerGuid },
    select: { guid: true },
  });
  const jobGuids = jobs.map((j) => j.guid);
  const invoices = await prisma.invoices.findMany({
    where: {
      post_lot: { not: null },
      OR: [
        { owner_type: endOwnerType, owner_guid: ownerGuid },
        ...(jobGuids.length > 0 ? [{ owner_type: OWNER_TYPE_JOB, owner_guid: { in: jobGuids } }] : []),
      ],
    },
    select: { guid: true, id: true, post_lot: true, post_txn: true },
  });
  if (invoices.length === 0) return [];

  const lotToInvoice = new Map<string, { guid: string; id: string; postTxn: string | null }>();
  for (const inv of invoices) {
    if (inv.post_lot) lotToInvoice.set(inv.post_lot, { guid: inv.guid, id: inv.id, postTxn: inv.post_txn });
  }

  const splits = await prisma.splits.findMany({
    where: { lot_guid: { in: Array.from(lotToInvoice.keys()) } },
    select: { tx_guid: true, lot_guid: true, value_num: true, value_denom: true },
  });

  // Payment splits = lot splits not belonging to the invoice's posting txn
  const byTxn = new Map<string, Array<{ lotGuid: string; value: number }>>();
  for (const s of splits) {
    if (!s.lot_guid) continue;
    const inv = lotToInvoice.get(s.lot_guid);
    if (!inv || s.tx_guid === inv.postTxn) continue;
    const arr = byTxn.get(s.tx_guid) ?? [];
    arr.push({ lotGuid: s.lot_guid, value: toDecimalNumber(s.value_num, s.value_denom) });
    byTxn.set(s.tx_guid, arr);
  }
  if (byTxn.size === 0) return [];

  const txns = await prisma.transactions.findMany({
    where: { guid: { in: Array.from(byTxn.keys()) } },
    select: { guid: true, post_date: true, num: true, description: true },
  });
  const txnByGuid = new Map(txns.map((t) => [t.guid, t]));

  // For an invoice, payment splits are credits (negative); for bills, debits.
  const sign = kind === 'invoice' ? -1 : 1;
  const views: PaymentView[] = [];
  for (const [txGuid, entries] of byTxn.entries()) {
    const t = txnByGuid.get(txGuid);
    const allocations = entries.map((e) => {
      const inv = lotToInvoice.get(e.lotGuid)!;
      return { invoiceGuid: inv.guid, invoiceId: inv.id, amount: roundCurrency(sign * e.value) };
    });
    views.push({
      transactionGuid: txGuid,
      date: toIsoDate(t?.post_date ?? null),
      num: t?.num ?? '',
      description: t?.description ?? '',
      amount: roundCurrency(allocations.reduce((s, a) => s + a.amount, 0)),
      allocations,
    });
  }
  views.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return views;
}

// ---------------------------------------------------------------------------
// Reads: getInvoiceWithStatus / listInvoices
// ---------------------------------------------------------------------------

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof prisma.invoices.findUnique>>>;

export async function buildInvoiceView(
  db: PrismaTx,
  invoice: InvoiceRow,
  opts: { includeEntries: boolean },
): Promise<InvoiceDetailView> {
  const owner = await resolveOwner(db, invoice.owner_type ?? 0, invoice.owner_guid ?? '');
  const kind = owner.kind;

  const entryRows: EntryRow[] = await db.entries.findMany({
    where: kind === 'invoice' ? { invoice: invoice.guid } : { bill: invoice.guid },
    orderBy: { date: 'asc' },
  });
  const taxTableGuids = entryRows
    .map((r) => (kind === 'invoice' ? r.i_taxtable : r.b_taxtable))
    .filter((g): g is string => Boolean(g));
  const taxTables = await loadTaxTables(db, taxTableGuids);
  const lines = entryRows.map((r) => entryRowToLine(r, kind, taxTables));

  const fraction = await getCurrencyFraction(db, invoice.currency);
  const totals = computeInvoiceTotals(lines, fraction);

  // Amount due from lot split values
  let amountDue = 0;
  const posted = Boolean(invoice.post_txn);
  if (posted && invoice.post_lot) {
    const lotSplits: Array<{ value_num: bigint; value_denom: bigint }> = await db.splits.findMany({
      where: { lot_guid: invoice.post_lot },
      select: { value_num: true, value_denom: true },
    });
    amountDue = amountDueFromLotSplits(
      kind,
      lotSplits.map((s) => toDecimalNumber(s.value_num, s.value_denom)),
      fraction,
    );
  } else if (!posted) {
    amountDue = totals.total;
  }

  // Due date from bill terms
  let dueDate: Date | null = null;
  if (posted && invoice.date_posted) {
    let term: BillTermSpec | null = null;
    if (invoice.terms) {
      const t = await db.billterms.findUnique({ where: { guid: invoice.terms } });
      if (t) term = { type: t.type, duedays: t.duedays, cutoff: t.cutoff };
    }
    dueDate = computeDueDate(invoice.date_posted, term);
  }

  const status = invoiceStatus(posted, amountDue, dueDate, new Date(), fraction);

  const entries: EntryView[] = opts.includeEntries
    ? entryRows.map((r, i) => {
        const line = lines[i];
        const computed = totals.entries[i];
        return {
          guid: r.guid,
          date: toIsoDate(r.date),
          description: r.description ?? '',
          action: r.action ?? '',
          notes: r.notes ?? '',
          quantity: line.quantity,
          price: line.price,
          accountGuid: line.accountGuid || null,
          discount: line.discount ?? 0,
          discountType: line.discountType ?? 'VALUE',
          discountHow: line.discountHow ?? 'PRETAX',
          taxable: line.taxable !== false,
          taxIncluded: Boolean(line.taxIncluded),
          taxTableGuid: kind === 'invoice' ? (r.i_taxtable ?? null) : (r.b_taxtable ?? null),
          computed: {
            subtotal: computed.subtotal,
            discountValue: computed.discountValue,
            net: computed.net,
            taxTotal: computed.taxTotal,
            gross: computed.gross,
          },
        };
      })
    : [];

  return {
    guid: invoice.guid,
    id: invoice.id,
    type: kind,
    ownerType: ownerTypeIntToName(invoice.owner_type ?? 0),
    ownerGuid: invoice.owner_guid ?? '',
    ownerName: owner.name,
    dateOpened: toIsoDate(invoice.date_opened),
    datePosted: toIsoDate(invoice.date_posted),
    dueDate: toIsoDate(dueDate),
    notes: invoice.notes,
    billingId: invoice.billing_id ?? null,
    termsGuid: invoice.terms ?? null,
    currencyGuid: invoice.currency,
    active: invoice.active === 1,
    posted,
    postTxnGuid: invoice.post_txn ?? null,
    postAccountGuid: invoice.post_acc ?? null,
    postLotGuid: invoice.post_lot ?? null,
    totals: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
    },
    amountDue,
    status,
    entries,
  };
}

export async function getInvoiceWithStatus(guid: string): Promise<InvoiceDetailView> {
  const invoice = await prisma.invoices.findUnique({ where: { guid } });
  if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
  return buildInvoiceView(prisma as unknown as PrismaTx, invoice, { includeEntries: true });
}

export async function listInvoices(filters: ListInvoicesFilters = {}): Promise<InvoiceView[]> {
  const invoices = await prisma.invoices.findMany({
    where: filters.ownerGuid ? { owner_guid: filters.ownerGuid } : undefined,
    orderBy: [{ date_opened: 'desc' }],
  });

  // Classify job-owned documents by resolving the job's owner type
  const jobGuids = invoices
    .filter((i) => i.owner_type === OWNER_TYPE_JOB)
    .map((i) => i.owner_guid)
    .filter((g): g is string => Boolean(g));
  const jobs = jobGuids.length
    ? await prisma.jobs.findMany({
        where: { guid: { in: Array.from(new Set(jobGuids)) } },
        select: { guid: true, owner_type: true },
      })
    : [];
  const jobOwnerType = new Map(jobs.map((j) => [j.guid, j.owner_type]));

  const kindOf = (inv: (typeof invoices)[number]): InvoiceKind | null => {
    if (inv.owner_type === OWNER_TYPE_CUSTOMER) return 'invoice';
    if (inv.owner_type === OWNER_TYPE_VENDOR) return 'bill';
    if (inv.owner_type === OWNER_TYPE_JOB) {
      const t = jobOwnerType.get(inv.owner_guid ?? '');
      if (t === OWNER_TYPE_CUSTOMER) return 'invoice';
      if (t === OWNER_TYPE_VENDOR) return 'bill';
    }
    return null;
  };

  const filtered = invoices.filter((inv) => {
    const kind = kindOf(inv);
    if (!kind) return false;
    if (filters.type && kind !== filters.type) return false;
    return true;
  });

  const views: InvoiceView[] = [];
  for (const inv of filtered) {
    try {
      const view = await buildInvoiceView(prisma as unknown as PrismaTx, inv, { includeEntries: false });
      views.push(view);
    } catch {
      // Skip documents whose owner rows are missing (orphaned data)
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
