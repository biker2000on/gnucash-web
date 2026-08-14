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
 * UNPOST reverses; it does not delete (see unpostInvoice). The posting
 * transaction, its splits and its lot all survive, a second transaction with
 * equal and opposite splits cancels them, and the invoice row's posting fields
 * are cleared so it reads as a draft again. This diverges from desktop
 * gncInvoiceUnpost, which destroys the transaction: destroying it takes the
 * audit trail with it, silently restates a closed period, and can delete a
 * split that was reconciled against a statement.
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

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { generateGuid, toDecimalNumber, fromDecimal, findOrCreateAccount } from '@/lib/gnucash';
import {
  assertNotLocked,
  getBookGuidForAccount,
  getBookGuidForRoot,
} from '@/lib/services/period-lock.service';
import {
  recordEntityOwnership,
  isEntityOwnedByBook,
  deleteEntityOwnership,
  type BusinessEntityType,
  type EntityOwnershipClient,
} from './entity-ownership';
// Single source of truth for "what is this posted document's due date", shared
// with the AR/AP aging report and the dunning job. business-reports.ts imports
// only prisma + slot constants, so importing it here is cycle-free.
import { resolveAgingDueDate } from './business-reports';
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

// Audit slots written by unpostInvoice. These are OUR namespace, not GnuCash's:
// the native 'gncInvoice' frame means "this object IS invoice X's live posting",
// which stops being true the moment the invoice is unposted. GnuCash preserves
// unknown KVP untouched, so the trail survives an export/import round trip.
/** On the reversing txn: guid of the posting transaction it reverses. */
const SLOT_REVERSES_TXN = 'gncweb-reverses-txn';
/** On the reversed posting txn: guid of the transaction that reversed it. */
const SLOT_REVERSED_BY_TXN = 'gncweb-reversed-by-txn';
/** On both: guid of the invoice whose posting was unposted. */
const SLOT_UNPOSTED_INVOICE = 'gncweb-unposted-invoice-guid';

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
  /**
   * True when the posting transaction carries no `trans-date-due` slot and the
   * due date above is the POST DATE standing in for it. Same flag, same
   * fallback, as the aging report's `AgingInvoice.dueDateInferred`.
   */
  dueDateInferred: boolean;
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

// ---------------------------------------------------------------------------
// Book scope (audit S5)
//
// `invoices`, `entries`, `customers`, `vendors` and `jobs` are native GnuCash
// tables with no book_guid — the desktop app assumes one book per database.
// Ownership therefore lives in gnucash_web_business_entity_ownership and
// MISSING OWNERSHIP MEANS FOREIGN: every entry point below takes the caller's
// book as its first argument and treats an unowned document as not found.
// ---------------------------------------------------------------------------

function ownershipClient(db: PrismaTx): EntityOwnershipClient {
  return db as unknown as EntityOwnershipClient;
}

function ownerEntityType(ownerType: number): BusinessEntityType {
  if (ownerType === OWNER_TYPE_CUSTOMER) return 'customer';
  if (ownerType === OWNER_TYPE_VENDOR) return 'vendor';
  if (ownerType === OWNER_TYPE_JOB) return 'job';
  if (ownerType === OWNER_TYPE_EMPLOYEE) return 'employee';
  throw new InvoiceValidationError(`Unsupported owner type: ${ownerType}`);
}

/** Foreign owners are reported as missing — a book must not learn they exist. */
async function assertOwnerInBook(
  db: PrismaTx,
  bookGuid: string,
  ownerType: number,
  ownerGuid: string,
): Promise<void> {
  const entityType = ownerEntityType(ownerType);
  if (!(await isEntityOwnedByBook(entityType, ownerGuid, bookGuid, ownershipClient(db)))) {
    throw new InvoiceNotFoundError(`${entityType} not found: ${ownerGuid}`);
  }
}

async function assertInvoiceInBook(db: PrismaTx, bookGuid: string, guid: string): Promise<void> {
  if (!(await isEntityOwnedByBook('invoice', guid, bookGuid, ownershipClient(db)))) {
    throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
  }
}

async function bookRootGuidFor(db: PrismaTx, bookGuid: string): Promise<string> {
  const book = await db.books.findUnique({
    where: { guid: bookGuid },
    select: { root_account_guid: true },
  });
  if (!book) throw new InvoiceValidationError(`Book not found: ${bookGuid}`);
  return book.root_account_guid;
}

/**
 * Every referenced account must sit under the book's root. Posting or paying
 * into another book's account would write splits into both books at once, so a
 * foreign account is rejected as missing rather than used.
 */
async function assertAccountsInBook(
  db: PrismaTx,
  bookRootGuid: string,
  accountGuids: Array<string | null | undefined>,
  label: string,
): Promise<void> {
  const unique = Array.from(new Set(accountGuids.filter((g): g is string => Boolean(g))));
  if (unique.length === 0) return;

  const all: Array<{ guid: string; parent_guid: string | null }> = await db.accounts.findMany({
    select: { guid: true, parent_guid: true },
  });
  const byGuid = new Map(all.map((a) => [a.guid, a]));
  const underRoot = (guid: string): boolean => {
    let cur = byGuid.get(guid) ?? null;
    for (let i = 0; i < 200 && cur; i++) {
      if (cur.guid === bookRootGuid) return true;
      cur = cur.parent_guid ? (byGuid.get(cur.parent_guid) ?? null) : null;
    }
    return false;
  };

  const foreign = unique.filter((g) => !underRoot(g));
  if (foreign.length > 0) {
    throw new InvoiceNotFoundError(`${label} not found: ${foreign.join(', ')}`);
  }
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

/** Write (or overwrite) a flat string slot on an object. */
async function writeStringSlot(
  db: PrismaTx,
  objGuid: string,
  name: string,
  value: string,
): Promise<void> {
  await db.slots.deleteMany({ where: { obj_guid: objGuid, name } });
  await db.slots.create({
    data: { obj_guid: objGuid, name, slot_type: SLOT_STRING, string_val: value },
  });
}

/**
 * Delete ONE named frame slot (and its children) from an object, leaving the
 * object's other slots alone.
 */
async function deleteFrameSlot(db: PrismaTx, objGuid: string, frameName: string): Promise<void> {
  const rows = await db.slots.findMany({ where: { obj_guid: objGuid, name: frameName } });
  for (const r of rows) {
    if (r.slot_type === SLOT_FRAME && r.guid_val) {
      await deleteSlotsRecursive(db, r.guid_val);
    }
  }
  await db.slots.deleteMany({ where: { obj_guid: objGuid, name: frameName } });
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
 * Minimal structural DB surface for the counter logic, so it stays
 * unit-testable with an in-memory fake. Satisfied by a Prisma interactive
 * transaction client ($queryRaw is required for the atomic increment and the
 * bootstrap advisory lock — callers MUST run this inside a $transaction).
 */
export interface CounterDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  slots: {
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<{ id: number; guid_val?: string | null; int64_val?: bigint | null } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  invoices: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Array<{ id: string }>>;
  };
}

/**
 * Next document number from the book's 'counters/<counterName>' slot.
 *
 * Concurrency-safe: the increment is a single atomic
 * `UPDATE ... SET int64_val = int64_val + 1 ... RETURNING`, so two concurrent
 * calls serialize on the row and always hand out distinct numbers (the old
 * read-modify-write handed out duplicates). The bootstrap path (no counter
 * slot yet) is guarded by pg_advisory_xact_lock keyed on (book, counter) —
 * the loser re-checks after the lock and increments the winner's slot instead
 * of creating a duplicate; the max-numeric-id fallback also runs under that
 * lock. MUST be called inside a $transaction (xact-scoped advisory lock).
 *
 * `ownedGuids` scopes the max-numeric-id fallback to the book's own documents;
 * without it the bootstrap path reads other books' invoice numbers. It is a
 * lazy thunk because it is only needed on the (rare) bootstrap path.
 */
export async function nextCounterId(
  db: CounterDb,
  bookGuid: string,
  counterName: string,
  fallbackOwnerType: number,
  /** Restricts the bootstrap seed to documents this book owns. */
  scopeBookGuid?: string | null,
): Promise<string> {
  // GnuCash frame layout: book -> 'counters' frame -> child on the frame
  // guid; tolerate flat layouts (obj_guid = book guid, full-path name).
  const findCounter = async () => {
    const frame = await db.slots.findFirst({
      where: { obj_guid: bookGuid, name: 'counters', slot_type: SLOT_FRAME },
    });
    let counterRow = frame?.guid_val
      ? await db.slots.findFirst({
          where: { obj_guid: frame.guid_val, name: `counters/${counterName}` },
        })
      : null;
    if (!counterRow) {
      counterRow = await db.slots.findFirst({
        where: { obj_guid: bookGuid, name: `counters/${counterName}` },
      });
    }
    return { frame, counterRow };
  };

  // Stored value is the LAST used number; atomically bump and use the result.
  const increment = async (slotId: number): Promise<string> => {
    const rows = await db.$queryRaw<Array<{ int64_val: bigint | number | null }>>`
      UPDATE slots SET int64_val = COALESCE(int64_val, 0) + 1
      WHERE id = ${slotId}
      RETURNING int64_val
    `;
    const value = rows[0]?.int64_val;
    if (value === null || value === undefined) {
      throw new Error(`Counter slot ${slotId} vanished during increment`);
    }
    return formatInvoiceId(Number(value));
  };

  let { frame, counterRow } = await findCounter();
  if (counterRow) return increment(counterRow.id);

  // Bootstrap: serialize concurrent bootstraps of this counter, then re-check
  // existence — the lock loser must increment the winner's slot, not create a
  // second one.
  // ::text cast on the result: void return breaks Prisma $queryRaw deserialization.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`gncCounter:${bookGuid}:${counterName}`}::text))::text AS locked`;
  ({ frame, counterRow } = await findCounter());
  if (counterRow) return increment(counterRow.id);

  // Fallback: max numeric id among same-kind documents (job-owned ignored),
  // then persist a GnuCash-style counter so future numbering is stable and
  // desktop sees the counter. Scoped through the ownership view so the seed
  // never reads another book's document numbers.
  const rows = await db.invoices.findMany({
    where: {
      owner_type: fallbackOwnerType,
      ...(scopeBookGuid ? { ownership: { book_guid: scopeBookGuid } } : {}),
    },
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
      name: `counters/${counterName}`,
      slot_type: SLOT_INT64,
      int64_val: BigInt(next),
    },
  });

  return formatInvoiceId(next);
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
  const ownerType = kind === 'invoice' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR;
  return nextCounterId(db as unknown as CounterDb, bookGuid, counterName, ownerType, bookGuid);
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

export async function createInvoice(
  bookGuid: string,
  input: CreateInvoiceInput,
): Promise<InvoiceDetailView> {
  const guid = generateGuid();
  await prisma.$transaction(async (tx) => {
    const ownerTypeInt = ownerTypeNameToInt(input.ownerType);
    // A document inherits its owner's book: billing another book's customer
    // must fail rather than pull that customer into this book.
    await assertOwnerInBook(tx, bookGuid, ownerTypeInt, input.ownerGuid);
    const owner = await resolveOwner(tx, ownerTypeInt, input.ownerGuid);
    if (ownerTypeInt === OWNER_TYPE_JOB) {
      await assertOwnerInBook(tx, bookGuid, owner.endType, owner.endGuid);
    }
    const kind = owner.kind;

    await validateEntries(tx, kind, input.entries);
    await assertAccountsInBook(
      tx,
      await bookRootGuidFor(tx, bookGuid),
      input.entries.map((e) => e.accountGuid),
      'Entry account(s)',
    );

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
      : await nextInvoiceId(tx, bookGuid, kind);

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

    // Same transaction as the insert: an invoice can never commit unowned.
    await recordEntityOwnership('invoice', guid, bookGuid, ownershipClient(tx));

    await createEntryRows(tx, guid, kind, input.entries, dateOpened);
  });

  const view = await getInvoiceWithStatus(bookGuid, guid);
  if (!view) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
  return view;
}

/** Null when the invoice is missing or belongs to another book. */
export async function updateInvoice(
  bookGuid: string,
  guid: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceDetailView | null> {
  let found = true;
  await prisma.$transaction(async (tx) => {
    if (!(await isEntityOwnedByBook('invoice', guid, bookGuid, ownershipClient(tx)))) {
      found = false;
      return;
    }
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) {
      found = false;
      return;
    }
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
      await assertAccountsInBook(
        tx,
        await bookRootGuidFor(tx, bookGuid),
        input.entries.map((e) => e.accountGuid),
        'Entry account(s)',
      );
      await tx.entries.deleteMany({
        where: kind === 'invoice' ? { invoice: guid } : { bill: guid },
      });
      await createEntryRows(tx, guid, kind, input.entries, dateOpened ?? new Date());
    }
  });

  if (!found) return null;
  return getInvoiceWithStatus(bookGuid, guid);
}

/** Null when the invoice is missing or belongs to another book. */
export async function deleteInvoice(
  bookGuid: string,
  guid: string,
): Promise<{ guid: string } | null> {
  let found = true;
  await prisma.$transaction(async (tx) => {
    if (!(await isEntityOwnedByBook('invoice', guid, bookGuid, ownershipClient(tx)))) {
      found = false;
      return;
    }
    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) {
      found = false;
      return;
    }
    if (invoice.post_txn) {
      throw new InvoiceStateError('Cannot delete a posted invoice — unpost it first');
    }
    await tx.entries.deleteMany({ where: { OR: [{ invoice: guid }, { bill: guid }] } });
    await deleteSlotsRecursive(tx, guid);
    await tx.invoices.delete({ where: { guid } });
    // The ownership row dies with the invoice, in the same transaction.
    await deleteEntityOwnership('invoice', guid, ownershipClient(tx));
  });
  return found ? { guid } : null;
}

// ---------------------------------------------------------------------------
// postInvoice / unpostInvoice
// ---------------------------------------------------------------------------

export async function postInvoice(
  bookGuid: string,
  guid: string,
  input: PostInvoiceInput,
): Promise<PostResult> {
  let result: PostResult | null = null;

  // A/R–A/P discovery scope is DERIVED from the caller's book, never supplied:
  // posting into another book's receivable account would corrupt both books.
  const bookRootGuid = await bookRootGuidFor(prisma as unknown as PrismaTx, bookGuid);

  // Period lock: posting creates the A/R–A/P transaction at postDate
  const lockBookGuid = await getBookGuidForRoot(bookRootGuid);
  if (lockBookGuid) await assertNotLocked(lockBookGuid, [input.postDate]);

  await prisma.$transaction(async (tx) => {
    await assertInvoiceInBook(tx, bookGuid, guid);

    // Serialize concurrent posts of the same invoice: without this row lock,
    // two posts can both pass the already-posted check below and double-book
    // A/R. The loser blocks here until the winner commits, then re-reads the
    // row and hits the InvoiceStateError.
    await tx.$queryRaw`SELECT guid FROM invoices WHERE guid = ${guid} FOR UPDATE`;

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

    // A/R–A/P account (constrained to the book root resolved above)
    const postAccountGuid = await findOrCreatePostAccount(tx, kind, bookRootGuid, invoice.currency);

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
    // Covers the A/R–A/P account plus every income/expense and tax account the
    // lines reach: no split of this posting may land outside the book.
    await assertAccountsInBook(
      tx,
      bookRootGuid,
      splitSpecs.map((s) => s.accountGuid),
      'Posting account(s)',
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

/** Greatest common divisor of two BigInts; never returns 0. */
function bigintGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * Exact sum of split values as a reduced fraction. Split denominators are not
 * always the currency fraction, so this sums as rationals rather than through
 * a float — a transaction that balances must sum to exactly 0/1.
 */
function sumSplitValues(
  splits: readonly { value_num: bigint; value_denom: bigint }[],
): { num: bigint; denom: bigint } {
  let num = 0n;
  let denom = 1n;
  for (const s of splits) {
    num = num * s.value_denom + s.value_num * denom;
    denom = denom * s.value_denom;
    const g = bigintGcd(num, denom);
    num /= g;
    denom /= g;
  }
  return { num, denom };
}

/** A posting split, in the shape the reversal copies from. */
type PostingSplitRow = {
  guid: string;
  account_guid: string;
  action: string;
  value_num: bigint;
  value_denom: bigint;
  quantity_num: bigint;
  quantity_denom: bigint;
  lot_guid: string | null;
};

/**
 * Refuse to reverse a posting that is no longer the one we wrote.
 *
 * A reversal is only sound when the transaction it mirrors is intact: every
 * split it negates must be a split this engine posted, and the A/R–A/P leg
 * must still be the one carrying the invoice's lot. Where the old delete-based
 * unpost destroyed whatever it found, this fails loudly and names the fix —
 * there is no fallback to delete, because a delete is exactly the outcome that
 * makes the tampering unrecoverable.
 */
function assertReversiblePosting(
  invoice: { id: string; post_txn: string | null; post_acc: string | null; post_lot: string | null },
  postingTxn: { guid: string } | null,
  splits: readonly PostingSplitRow[],
): void {
  const txGuid = invoice.post_txn;
  if (!postingTxn) {
    throw new InvoiceStateError(
      `Cannot unpost invoice ${invoice.id}: its posting transaction ${txGuid} no longer exists,`
      + ' so there is nothing to reverse. The invoice\'s post_txn link is dangling —'
      + ' repair the book before unposting.',
    );
  }
  if (splits.length === 0) {
    throw new InvoiceStateError(
      `Cannot unpost invoice ${invoice.id}: posting transaction ${txGuid} has no splits left,`
      + ' so a reversal would post nothing. The posting has been altered since it was written —'
      + ' repair the book before unposting.',
    );
  }
  if (splits.some((s) => s.value_denom === 0n || s.quantity_denom === 0n)) {
    throw new InvoiceStateError(
      `Cannot unpost invoice ${invoice.id}: posting transaction ${txGuid} has a split with a zero`
      + ' denominator, which cannot be negated. Repair the split before unposting.',
    );
  }

  const sum = sumSplitValues(splits);
  if (sum.num !== 0n) {
    throw new InvoiceStateError(
      `Cannot unpost invoice ${invoice.id}: posting transaction ${txGuid} does not balance`
      + ` (its splits sum to ${sum.num}/${sum.denom}, not zero). It has been edited since it was`
      + ' posted; reversing an unbalanced transaction would write a second unbalanced one.'
      + ' Correct the transaction so it balances, then unpost.',
    );
  }

  // The A/R–A/P leg is what ties the posting to the invoice. If it was moved
  // to another account — or split in two, or stripped of its lot — a reversal
  // can no longer be matched to the invoice's lot.
  if (invoice.post_lot) {
    const lotSplits = splits.filter((s) => s.lot_guid === invoice.post_lot);
    if (lotSplits.length !== 1) {
      throw new InvoiceStateError(
        `Cannot unpost invoice ${invoice.id}: expected exactly one split of posting transaction`
        + ` ${txGuid} to carry lot ${invoice.post_lot}, found ${lotSplits.length}.`
        + ' The posting has been edited since it was written — restore its receivable/payable'
        + ' split before unposting.',
      );
    }
    if (invoice.post_acc && lotSplits[0].account_guid !== invoice.post_acc) {
      throw new InvoiceStateError(
        `Cannot unpost invoice ${invoice.id}: the receivable/payable split of posting transaction`
        + ` ${txGuid} has moved from account ${invoice.post_acc} to ${lotSplits[0].account_guid}.`
        + ' Move it back before unposting.',
      );
    }
  }
}

/**
 * Post date for the reversing transaction: TODAY, or the original post date
 * when that is still in the future.
 *
 * Today is the choice, for three reasons:
 *
 *  1. Period integrity. A reversal dated back to the original posting silently
 *     rewrites a period that may already be closed, reported or filed. Dating
 *     it today is the standard correcting-entry treatment: the period keeps
 *     the numbers it was signed off with, and the correction shows up in the
 *     period the correction was actually made.
 *  2. It follows the only reversing-entry precedent in this codebase.
 *     `maybePostReturn` (inventory-engine.ts) dates the reversing COGS entry
 *     of a return at the RETURN's date, not at the shipment's, for the same
 *     reason.
 *  3. It composes with the period lock instead of fighting it. The old
 *     delete-based unpost had to check the ORIGINAL post date against
 *     `assertNotLocked`, so unposting anything in a closed period was simply
 *     impossible. A reversal touches only today, so a locked prior period no
 *     longer blocks the correction — and the lock still does its job, because
 *     nothing dated inside it is written.
 *
 * The one refinement: an invoice may be posted with a FUTURE date. A reversal
 * dated before the posting it reverses is nonsense on a running balance, so
 * the reversal never precedes its original.
 */
function reversalPostDate(originalPostDate: Date | null, now: Date): Date {
  const today = new Date(now.toISOString().slice(0, 10) + 'T12:00:00Z');
  if (originalPostDate && originalPostDate.getTime() > today.getTime()) return originalPostDate;
  return today;
}

/**
 * Unpost by REVERSING, never by deleting.
 *
 * Double-entry books do not un-happen a posting: the posting transaction and
 * its splits stay exactly as written, and a second transaction with equal and
 * opposite splits cancels them. Every affected account nets to zero, the audit
 * trail survives, and a split someone had reconciled against a statement keeps
 * both its amount and its reconciled state.
 *
 * What changes, per object:
 *   - posting txn: untouched financially. Its `gncInvoice` frame slot (the
 *     native "this IS invoice X's posting" pointer) is removed, because the
 *     invoice is about to say it has no posting and GnuCash desktop would
 *     otherwise offer to edit an invoice that no longer claims this
 *     transaction. The same link is kept in readable form in
 *     'gncweb-unposted-invoice-guid' / 'gncweb-reversed-by-txn', and
 *     'trans-read-only' is re-worded (it used to advise unposting an invoice
 *     that by then is already unposted).
 *   - reversal txn: negated copy of every split, same accounts, same lot on
 *     the receivable/payable leg, reconcile_state 'n'.
 *   - lot: KEPT (the original split still references it — the FK forbids
 *     deleting it) and closed, since posting + reversal sum to zero. Its
 *     `gncInvoice` slot goes, so exactly one lot ever claims the invoice.
 *   - invoice row: date_posted/post_txn/post_acc/post_lot cleared, so it reads
 *     as a draft and can be edited, deleted or re-posted. Re-posting writes a
 *     fresh transaction and lot; it cannot double-count, because the previous
 *     pair already nets to zero.
 *
 * NO reconciled-split guard here, deliberately. `assertNoReconciledSplits`
 * exists to stop five mutations — changing a split's amount or account,
 * changing its parent's post date, deleting a split, deleting a transaction —
 * and this path performs none of them. It only INSERTs new, unreconciled
 * splits in a new transaction. A reconciled split keeps its value, its
 * account, its parent post date and its 'y'/'f' state, so the balance the
 * statement was agreed against is unchanged. The delete-based version DID need
 * the guard (it deleted reconciled splits outright) and had it; reversing
 * removes the reason for it, and keeping it would only block a legitimate
 * correction on a book whose A/R has been reconciled.
 */
export async function unpostInvoice(bookGuid: string, guid: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await assertInvoiceInBook(tx, bookGuid, guid);

    // Mirror of the postInvoice lock: serialize unpost against a concurrent
    // post/unpost/payment of the same invoice so the state checks below run
    // against committed state (a double unpost gets 'Invoice is not posted'
    // instead of a second reversal).
    await tx.$queryRaw`SELECT guid FROM invoices WHERE guid = ${guid} FOR UPDATE`;

    const invoice = await tx.invoices.findUnique({ where: { guid } });
    if (!invoice) throw new InvoiceNotFoundError(`Invoice not found: ${guid}`);
    if (!invoice.post_txn) throw new InvoiceStateError('Invoice is not posted');
    const postTxnGuid = invoice.post_txn;

    // Refuse when payments are attached to the lot
    if (invoice.post_lot) {
      const lotSplits = await tx.splits.findMany({
        where: { lot_guid: invoice.post_lot },
        select: { guid: true, tx_guid: true },
      });
      const foreign = lotSplits.filter((s: { tx_guid: string }) => s.tx_guid !== postTxnGuid);
      if (foreign.length > 0) {
        throw new InvoiceStateError(
          'Cannot unpost: payments are applied to this invoice. Remove the payment transactions first.',
        );
      }
    }

    const postingTxn = await tx.transactions.findUnique({ where: { guid: postTxnGuid } });
    const postingSplits: PostingSplitRow[] = await tx.splits.findMany({
      where: { tx_guid: postTxnGuid },
      select: {
        guid: true,
        account_guid: true,
        action: true,
        value_num: true,
        value_denom: true,
        quantity_num: true,
        quantity_denom: true,
        lot_guid: true,
      },
    });
    assertReversiblePosting(invoice, postingTxn, postingSplits);

    const now = new Date();
    const reversalDate = reversalPostDate(postingTxn!.post_date, now);

    // Period lock: the reversal is the only dated row this writes. The
    // original posting is left alone, so its own (possibly locked) period is
    // not consulted — see reversalPostDate.
    if (invoice.post_acc) {
      const lockBookGuid = await getBookGuidForAccount(invoice.post_acc);
      if (lockBookGuid) await assertNotLocked(lockBookGuid, [reversalDate]);
    }

    // The reversing transaction: equal and opposite, same accounts, same lot.
    const reversalGuid = generateGuid();
    await tx.transactions.create({
      data: {
        guid: reversalGuid,
        currency_guid: postingTxn!.currency_guid,
        num: postingTxn!.num,
        post_date: reversalDate,
        enter_date: now,
        description: `Unpost reversal — ${postingTxn!.description || `invoice ${invoice.id}`}`,
      },
    });
    const reversalMemo = `Reverses invoice ${invoice.id} posted ${toIsoDate(postingTxn!.post_date) ?? 'undated'}`;
    for (const s of postingSplits) {
      await tx.splits.create({
        data: {
          guid: generateGuid(),
          tx_guid: reversalGuid,
          account_guid: s.account_guid,
          memo: reversalMemo,
          action: s.action,
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: -s.value_num,
          value_denom: s.value_denom,
          quantity_num: -s.quantity_num,
          quantity_denom: s.quantity_denom,
          lot_guid: s.lot_guid,
        },
      });
    }
    await writeStringSlot(tx, reversalGuid, SLOT_REVERSES_TXN, postTxnGuid);
    await writeStringSlot(tx, reversalGuid, SLOT_UNPOSTED_INVOICE, guid);
    await writeStringSlot(
      tx,
      reversalGuid,
      'trans-read-only',
      `Reverses the posting of invoice ${invoice.id}. Deleting it would leave that posting standing alone.`,
    );

    // Retire the original's native invoice linkage, keeping the history in a
    // form nothing will mistake for a live posting.
    await deleteFrameSlot(tx, postTxnGuid, 'gncInvoice');
    await writeStringSlot(tx, postTxnGuid, SLOT_UNPOSTED_INVOICE, guid);
    await writeStringSlot(tx, postTxnGuid, SLOT_REVERSED_BY_TXN, reversalGuid);
    await writeStringSlot(
      tx,
      postTxnGuid,
      'trans-read-only',
      `Reversed when invoice ${invoice.id} was unposted. Kept for the audit trail.`,
    );

    // The lot survives (the original split references it) and is closed:
    // posting + reversal sum to zero.
    if (invoice.post_lot) {
      await deleteFrameSlot(tx, invoice.post_lot, 'gncInvoice');
      await tx.lots.update({ where: { guid: invoice.post_lot }, data: { is_closed: 1 } });
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

/**
 * Where clause matching all POSTED documents of an owner (jobs included),
 * restricted to the documents this book owns. `ownedGuids` is the ownership
 * filter: an empty list means the book owns none, never "no filter".
 */
async function postedOwnerDocsWhere(
  db: PrismaTx,
  endOwnerType: number,
  ownerGuid: string,
  bookGuid: string,
): Promise<Prisma.invoicesWhereInput> {
  const jobs: Array<{ guid: string }> = await db.jobs.findMany({
    where: { ownership: { book_guid: bookGuid }, owner_type: endOwnerType, owner_guid: ownerGuid },
    select: { guid: true },
  });
  const jobGuids = jobs.map((j) => j.guid);
  return {
    ownership: { book_guid: bookGuid },
    post_txn: { not: null },
    OR: [
      { owner_type: endOwnerType, owner_guid: ownerGuid },
      ...(jobGuids.length > 0 ? [{ owner_type: OWNER_TYPE_JOB, owner_guid: { in: jobGuids } }] : []),
    ],
  };
}

/** Posted, not fully paid documents for an owner (jobs of the owner included). */
async function loadOpenDocuments(
  db: PrismaTx,
  where: Prisma.invoicesWhereInput,
  kind: InvoiceKind,
): Promise<OpenDocument[]> {
  const invoices = await db.invoices.findMany({ where });
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

export async function applyPayment(
  bookGuid: string,
  input: ApplyPaymentInput,
): Promise<PaymentResult> {
  if (!(input.amount > 0)) {
    throw new InvoiceValidationError('Payment amount must be positive');
  }
  const postDate = parseIsoDateNoon(input.date, 'date');

  // Idempotency fast path (e.g. webhook redelivery long after the fact).
  // This pre-transaction read is NOT race-safe — the authoritative check runs
  // again inside the $transaction below, after the invoice row locks.
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
    await assertOwnerInBook(tx, bookGuid, endOwnerType, input.ownerGuid);
    const owner = await resolveOwner(tx, endOwnerType, input.ownerGuid);
    const kind: InvoiceKind = owner.kind;

    // The money side must stay inside the book too.
    await assertAccountsInBook(
      tx,
      await bookRootGuidFor(tx, bookGuid),
      [input.transferAccountGuid],
      'Transfer account',
    );

    // Serialize concurrent payments for this owner: lock every posted
    // document row (deterministic guid order avoids deadlocks) BEFORE
    // amountDue is computed from lot splits, so the second payment blocks
    // here and then re-validates against post-first-payment balances
    // (over-application then hits the normal validation errors below).
    const docsWhere = await postedOwnerDocsWhere(tx, endOwnerType, input.ownerGuid, bookGuid);
    const lockCandidates: Array<{ guid: string }> = await tx.invoices.findMany({
      where: docsWhere,
      select: { guid: true },
    });
    const lockGuids = lockCandidates.map((c) => c.guid).sort();
    if (lockGuids.length > 0) {
      await tx.$queryRaw`
        SELECT guid FROM invoices
        WHERE guid IN (${Prisma.join(lockGuids)})
        ORDER BY guid
        FOR UPDATE
      `;
    }

    // Idempotency (checked INSIDE the transaction, after the row locks): a
    // concurrent retry carrying the same caller-supplied guid waits on the
    // locks above and then sees the committed payment here, instead of both
    // retries passing a pre-transaction check and double-posting.
    if (input.transactionGuid) {
      const existing = await tx.transactions.findUnique({
        where: { guid: input.transactionGuid },
        select: { guid: true },
      });
      if (existing) {
        result = {
          transactionGuid: existing.guid,
          allocations: input.allocations ?? [],
          fullyPaidInvoiceGuids: [],
        };
        return;
      }
    }

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

    const openDocs = await loadOpenDocuments(tx, docsWhere, kind);
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
  bookGuid: string,
  ownerType: 'customer' | 'vendor' | 'employee',
  ownerGuid: string,
): Promise<PaymentView[]> {
  const endOwnerType = ownerTypeNameToInt(ownerType);
  if (!(await isEntityOwnedByBook(ownerEntityType(endOwnerType), ownerGuid, bookGuid))) {
    return [];
  }
  const owner = await resolveOwner(prisma as unknown as PrismaTx, endOwnerType, ownerGuid);
  const kind = owner.kind;

  const jobs = await prisma.jobs.findMany({
    where: { ownership: { book_guid: bookGuid }, owner_type: endOwnerType, owner_guid: ownerGuid },
    select: { guid: true },
  });
  const jobGuids = jobs.map((j) => j.guid);
  const invoices = await prisma.invoices.findMany({
    where: {
      ownership: { book_guid: bookGuid },
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

/**
 * Per-invoice data preloaded by batch callers (listInvoices), so composing a
 * view issues ZERO queries. When omitted, buildInvoiceView self-loads each
 * piece exactly as before (single-invoice callers are unaffected).
 */
interface InvoiceViewPreload {
  owner: ResolvedOwner;
  /** Entry rows for this invoice, ordered by date ascending. */
  entryRows: EntryRow[];
  /** Tax tables covering (at least) the guids referenced by entryRows. */
  taxTables: Map<string, TaxTableSpec>;
  /** Currency fraction for invoice.currency. */
  fraction: number;
  /** Decimal split values on invoice.post_lot (empty when unposted). */
  lotSplitValues: number[];
  /** Stored `trans-date-due` on invoice.post_txn (null when absent/unposted). */
  storedDueDate: Date | null;
}

/**
 * Compose a view from an already-fetched invoice row. Book scope is the
 * CALLER's responsibility here — every exported entry point checks ownership
 * before handing a row to this function.
 */
export async function composeInvoiceView(
  db: PrismaTx,
  invoice: InvoiceRow,
  opts: { includeEntries: boolean },
  preloaded?: InvoiceViewPreload,
): Promise<InvoiceDetailView> {
  const owner = preloaded?.owner
    ?? await resolveOwner(db, invoice.owner_type ?? 0, invoice.owner_guid ?? '');
  const kind = owner.kind;

  let entryRows: EntryRow[];
  let taxTables: Map<string, TaxTableSpec>;
  if (preloaded) {
    entryRows = preloaded.entryRows;
    taxTables = preloaded.taxTables;
  } else {
    entryRows = await db.entries.findMany({
      where: kind === 'invoice' ? { invoice: invoice.guid } : { bill: invoice.guid },
      orderBy: { date: 'asc' },
    });
    const taxTableGuids = entryRows
      .map((r) => (kind === 'invoice' ? r.i_taxtable : r.b_taxtable))
      .filter((g): g is string => Boolean(g));
    taxTables = await loadTaxTables(db, taxTableGuids);
  }
  const lines = entryRows.map((r) => entryRowToLine(r, kind, taxTables));

  const fraction = preloaded?.fraction ?? await getCurrencyFraction(db, invoice.currency);
  const totals = computeInvoiceTotals(lines, fraction);

  // Amount due from lot split values
  let amountDue = 0;
  const posted = Boolean(invoice.post_txn);
  if (posted && invoice.post_lot) {
    let lotValues: number[];
    if (preloaded) {
      lotValues = preloaded.lotSplitValues;
    } else {
      const lotSplits: Array<{ value_num: bigint; value_denom: bigint }> = await db.splits.findMany({
        where: { lot_guid: invoice.post_lot },
        select: { value_num: true, value_denom: true },
      });
      lotValues = lotSplits.map((s) => toDecimalNumber(s.value_num, s.value_denom));
    }
    amountDue = amountDueFromLotSplits(kind, lotValues, fraction);
  } else if (!posted) {
    amountDue = totals.total;
  }

  // Due date — read from the posting transaction, NOT recomputed from the
  // owner's CURRENT bill terms. Posting resolves the due date once (explicit
  // override > bill terms > post date) and persists it as `trans-date-due`;
  // recomputing here made this screen disagree with the aging report and the
  // dunning job whenever an override was used or the terms were edited after
  // posting. `resolveAgingDueDate` is the shared fallback policy: stored slot,
  // else post date flagged inferred.
  let storedDueDate: Date | null = null;
  if (posted && invoice.post_txn) {
    if (preloaded) {
      storedDueDate = preloaded.storedDueDate;
    } else {
      const slot = await db.slots.findFirst({
        where: { obj_guid: invoice.post_txn, name: 'trans-date-due', slot_type: SLOT_TIMESPEC },
        orderBy: { id: 'desc' },
      });
      storedDueDate = slot?.timespec_val ?? null;
    }
  }
  const { dueDate, dueDateInferred } = posted
    ? resolveAgingDueDate({ datePosted: invoice.date_posted, dueDate: storedDueDate })
    : { dueDate: null, dueDateInferred: false };

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
    dueDateInferred,
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

/**
 * Full detail view of ONE invoice, or null when it is missing or owned by
 * another book (callers map null to 404 — a foreign guid is indistinguishable
 * from an unknown one).
 */
export async function buildInvoiceView(
  bookGuid: string,
  guid: string,
): Promise<InvoiceDetailView | null> {
  if (!(await isEntityOwnedByBook('invoice', guid, bookGuid))) return null;
  const invoice = await prisma.invoices.findUnique({ where: { guid } });
  if (!invoice) return null;
  return composeInvoiceView(prisma as unknown as PrismaTx, invoice, { includeEntries: true });
}

/** Null when the invoice is missing or belongs to another book. */
export async function getInvoiceWithStatus(
  bookGuid: string,
  guid: string,
): Promise<InvoiceDetailView | null> {
  return buildInvoiceView(bookGuid, guid);
}

export async function listInvoices(
  bookGuid: string,
  filters: ListInvoicesFilters = {},
): Promise<InvoiceView[]> {
  const invoices = await prisma.invoices.findMany({
    where: {
      // Joins the invoice ownership view. An unowned document cannot match, so
      // "this book owns none" falls out naturally — it is never "no filter".
      ownership: { book_guid: bookGuid },
      ...(filters.ownerGuid ? { owner_guid: filters.ownerGuid } : {}),
    },
    orderBy: [{ date_opened: 'desc' }],
  });
  if (invoices.length === 0) return [];

  // Classify job-owned documents by resolving the job's owner type
  const jobGuids = invoices
    .filter((i) => i.owner_type === OWNER_TYPE_JOB)
    .map((i) => i.owner_guid)
    .filter((g): g is string => Boolean(g));
  const jobs: Array<{ guid: string; owner_type: number | null; owner_guid: string | null }> =
    jobGuids.length
      ? await prisma.jobs.findMany({
          where: { guid: { in: Array.from(new Set(jobGuids)) } },
          select: { guid: true, owner_type: true, owner_guid: true },
        })
      : [];
  const jobByGuid = new Map(jobs.map((j) => [j.guid, j]));

  const kindOf = (inv: (typeof invoices)[number]): InvoiceKind | null => {
    if (inv.owner_type === OWNER_TYPE_CUSTOMER) return 'invoice';
    if (inv.owner_type === OWNER_TYPE_VENDOR) return 'bill';
    if (inv.owner_type === OWNER_TYPE_JOB) {
      const t = jobByGuid.get(inv.owner_guid ?? '')?.owner_type;
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
  if (filtered.length === 0) return [];

  // -------------------------------------------------------------------------
  // Batched owner resolution (replaces per-invoice resolveOwner queries).
  // Invoices whose owner rows are missing are skipped, matching the old
  // per-invoice try/catch behavior.
  // -------------------------------------------------------------------------
  const customerGuids = new Set<string>();
  const vendorGuids = new Set<string>();
  for (const inv of filtered) {
    const direct = inv.owner_guid ?? '';
    if (inv.owner_type === OWNER_TYPE_CUSTOMER) customerGuids.add(direct);
    else if (inv.owner_type === OWNER_TYPE_VENDOR) vendorGuids.add(direct);
    else if (inv.owner_type === OWNER_TYPE_JOB) {
      const job = jobByGuid.get(direct);
      if (!job?.owner_guid) continue;
      if (job.owner_type === OWNER_TYPE_CUSTOMER) customerGuids.add(job.owner_guid);
      else if (job.owner_type === OWNER_TYPE_VENDOR) vendorGuids.add(job.owner_guid);
    }
  }
  const customers: Array<{ guid: string; name: string; currency: string; terms: string | null }> =
    customerGuids.size
      ? await prisma.customers.findMany({ where: { guid: { in: [...customerGuids] } } })
      : [];
  const vendors: Array<{ guid: string; name: string; currency: string; terms: string | null }> =
    vendorGuids.size
      ? await prisma.vendors.findMany({ where: { guid: { in: [...vendorGuids] } } })
      : [];
  const customerByGuid = new Map(customers.map((c) => [c.guid, c]));
  const vendorByGuid = new Map(vendors.map((v) => [v.guid, v]));

  const resolveOwnerFromBatch = (inv: (typeof invoices)[number]): ResolvedOwner | null => {
    let endType = inv.owner_type ?? 0;
    let endGuid = inv.owner_guid ?? '';
    if (inv.owner_type === OWNER_TYPE_JOB) {
      const job = jobByGuid.get(endGuid);
      if (!job?.owner_guid) return null;
      endType = job.owner_type ?? 0;
      endGuid = job.owner_guid;
    }
    if (endType === OWNER_TYPE_CUSTOMER) {
      const c = customerByGuid.get(endGuid);
      if (!c) return null;
      return {
        endType: OWNER_TYPE_CUSTOMER, endGuid: c.guid,
        directType: inv.owner_type ?? 0, directGuid: inv.owner_guid ?? '',
        name: c.name, currencyGuid: c.currency, termsGuid: c.terms ?? null, kind: 'invoice',
      };
    }
    if (endType === OWNER_TYPE_VENDOR) {
      const v = vendorByGuid.get(endGuid);
      if (!v) return null;
      return {
        endType: OWNER_TYPE_VENDOR, endGuid: v.guid,
        directType: inv.owner_type ?? 0, directGuid: inv.owner_guid ?? '',
        name: v.name, currencyGuid: v.currency, termsGuid: v.terms ?? null, kind: 'bill',
      };
    }
    return null;
  };

  const withOwners = filtered
    .map((inv) => ({ inv, owner: resolveOwnerFromBatch(inv) }))
    .filter((x): x is { inv: (typeof invoices)[number]; owner: ResolvedOwner } => x.owner !== null);

  // Currency fractions (batched; a missing currency previously threw per
  // invoice and the row was skipped — preserve that by filtering here).
  const currencyGuids = [...new Set(withOwners.map((x) => x.inv.currency))];
  const commodityRows: Array<{ guid: string; fraction: number | null }> = currencyGuids.length
    ? await prisma.commodities.findMany({
        where: { guid: { in: currencyGuids } },
        select: { guid: true, fraction: true },
      })
    : [];
  const fractionByCurrency = new Map(commodityRows.map((c) => [c.guid, c.fraction || 100]));
  const resolvable = withOwners.filter((x) => fractionByCurrency.has(x.inv.currency));

  // Pagination: without a status filter the window is fixed here (ordering is
  // already pushed into SQL), so the heavy per-invoice data below is only
  // loaded for the requested page. A status filter needs computed
  // amountDue/dueDate first, so it slices after composing the views.
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 100;
  const page = filters.status ? resolvable : resolvable.slice(offset, offset + limit);
  if (page.length === 0) return [];

  // -------------------------------------------------------------------------
  // Batched per-page loads: entries, tax tables, lot splits, bill terms —
  // one query per table for the whole page instead of ~6 per invoice.
  // -------------------------------------------------------------------------
  const invoiceKindGuids = page.filter((x) => x.owner.kind === 'invoice').map((x) => x.inv.guid);
  const billKindGuids = page.filter((x) => x.owner.kind === 'bill').map((x) => x.inv.guid);
  const entryRows: EntryRow[] = await prisma.entries.findMany({
    where: {
      OR: [
        ...(invoiceKindGuids.length ? [{ invoice: { in: invoiceKindGuids } }] : []),
        ...(billKindGuids.length ? [{ bill: { in: billKindGuids } }] : []),
      ],
    },
    orderBy: { date: 'asc' },
  });
  const entriesByDoc = new Map<string, EntryRow[]>();
  for (const r of entryRows) {
    if (r.invoice) {
      const arr = entriesByDoc.get(`i:${r.invoice}`) ?? [];
      arr.push(r);
      entriesByDoc.set(`i:${r.invoice}`, arr);
    }
    if (r.bill) {
      const arr = entriesByDoc.get(`b:${r.bill}`) ?? [];
      arr.push(r);
      entriesByDoc.set(`b:${r.bill}`, arr);
    }
  }

  const taxTableGuids: string[] = [];
  for (const { inv, owner } of page) {
    const rows = entriesByDoc.get(`${owner.kind === 'invoice' ? 'i' : 'b'}:${inv.guid}`) ?? [];
    for (const r of rows) {
      const g = owner.kind === 'invoice' ? r.i_taxtable : r.b_taxtable;
      if (g) taxTableGuids.push(g);
    }
  }
  const taxTables = await loadTaxTables(prisma as unknown as PrismaTx, taxTableGuids);

  const lotGuids = page
    .map(({ inv }) => inv.post_lot)
    .filter((g): g is string => Boolean(g));
  const lotSplits: Array<{ lot_guid: string | null; value_num: bigint; value_denom: bigint }> =
    lotGuids.length
      ? await prisma.splits.findMany({
          where: { lot_guid: { in: lotGuids } },
          select: { lot_guid: true, value_num: true, value_denom: true },
        })
      : [];
  const valuesByLot = new Map<string, number[]>();
  for (const s of lotSplits) {
    if (!s.lot_guid) continue;
    const arr = valuesByLot.get(s.lot_guid) ?? [];
    arr.push(toDecimalNumber(s.value_num, s.value_denom));
    valuesByLot.set(s.lot_guid, arr);
  }

  // Stored due dates (`trans-date-due` on each posting txn) — one query for
  // the page. Ordered ascending so the highest slot id wins in the map, which
  // matches the single-invoice path's `orderBy: { id: 'desc' }`.
  const postTxnGuids = page
    .map(({ inv }) => inv.post_txn)
    .filter((g): g is string => Boolean(g));
  const dueSlots: Array<{ obj_guid: string; timespec_val: Date | null }> = postTxnGuids.length
    ? await prisma.slots.findMany({
        where: { obj_guid: { in: postTxnGuids }, name: 'trans-date-due', slot_type: SLOT_TIMESPEC },
        select: { obj_guid: true, timespec_val: true },
        orderBy: { id: 'asc' },
      })
    : [];
  const dueByTxn = new Map<string, Date | null>();
  for (const s of dueSlots) dueByTxn.set(s.obj_guid, s.timespec_val);

  // Compose views in memory (zero queries per invoice)
  const views: InvoiceView[] = [];
  for (const { inv, owner } of page) {
    try {
      const view = await composeInvoiceView(prisma as unknown as PrismaTx, inv, { includeEntries: false }, {
        owner,
        entryRows: entriesByDoc.get(`${owner.kind === 'invoice' ? 'i' : 'b'}:${inv.guid}`) ?? [],
        taxTables,
        fraction: fractionByCurrency.get(inv.currency)!,
        lotSplitValues: inv.post_lot ? (valuesByLot.get(inv.post_lot) ?? []) : [],
        storedDueDate: inv.post_txn ? (dueByTxn.get(inv.post_txn) ?? null) : null,
      });
      views.push(view);
    } catch {
      // Skip documents with inconsistent rows (matches old behavior)
      continue;
    }
  }

  if (filters.status) {
    return views.filter((v) => v.status === filters.status).slice(offset, offset + limit);
  }
  return views;
}
