/**
 * Invoice/Bill Totals — pure math (no DB access).
 *
 * Implements GnuCash's entry valuation algorithm (gncEntryComputeValueInt in
 * libgnucash/engine/gncEntry.c) so that totals computed here match what
 * GnuCash desktop shows for the same invoice:
 *
 *   1. aggregate  = quantity x price
 *   2. pretax     = aggregate, unless the tax table is "tax included", in
 *                   which case pretax = (aggregate - fixedTax) / (1 + pctTax)
 *   3. discount   - VALUE discounts are flat currency amounts.
 *                 - PERCENT discounts depend on discountHow:
 *                     PRETAX / SAMETIME : discount = pretax * pct/100
 *                     POSTTAX           : discount = (pretax + taxOnPretax) * pct/100
 *                   net = pretax - discount
 *   4. tax base   - PRETAX             : tax computed on the discounted value
 *                 - SAMETIME / POSTTAX : tax computed on the pre-discount value
 *
 * Sign conventions (GnuCash native):
 *   - Customer INVOICE posting: DEBIT (+) A/R for the total, CREDIT (-) each
 *     income account, CREDIT (-) each tax account.
 *   - Vendor BILL posting: CREDIT (-) A/P for the total, DEBIT (+) each
 *     expense account, DEBIT (+) each tax account.
 *   - Customer PAYMENT: DEBIT (+) the deposit account, CREDIT (-) A/R
 *     (split assigned into the invoice's lot). Vendor payment flips signs.
 *   - Amount still due = lot split-value sum for an invoice, and its negation
 *     for a bill. Zero balance == fully paid.
 *
 * Rounding: every posted piece (per-line net, per-line-per-account tax) is
 * rounded half-away-from-zero to the currency fraction (default 100 => cents),
 * and the invoice total is the sum of the rounded pieces, so the posting
 * transaction always balances exactly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvoiceKind = 'invoice' | 'bill';
export type DiscountType = 'VALUE' | 'PERCENT';
export type DiscountHow = 'PRETAX' | 'SAMETIME' | 'POSTTAX';

/** One row of a GnuCash tax table (taxtable_entries). type 1=VALUE, 2=PERCENT. */
export interface TaxTableEntrySpec {
  accountGuid: string;
  type: 'VALUE' | 'PERCENT';
  /** PERCENT: the percentage (5 == 5%). VALUE: flat currency amount per entry. */
  amount: number;
}

export interface TaxTableSpec {
  guid: string;
  entries: TaxTableEntrySpec[];
}

/** A line item, decimal-valued (fractions already converted). */
export interface EntryLineInput {
  /** Income (invoice) or expense (bill) account for the line's net value. */
  accountGuid: string;
  description?: string;
  quantity: number;
  price: number;
  /** VALUE: currency amount; PERCENT: 5 == 5%. Customer invoices only. */
  discount?: number;
  discountType?: DiscountType;
  discountHow?: DiscountHow;
  /** Defaults to true when a taxTable is present. */
  taxable?: boolean;
  /** Price already includes tax (tax is backed out of quantity x price). */
  taxIncluded?: boolean;
  taxTable?: TaxTableSpec | null;
}

export interface ComputedEntryTax {
  accountGuid: string;
  amount: number;
}

export interface ComputedEntry {
  /** Pre-discount, pre-tax value (rounded). */
  subtotal: number;
  /** Discount amount actually applied (rounded). */
  discountValue: number;
  /** Net value posted to the line's income/expense account (rounded). */
  net: number;
  /** Tax amounts per tax-table entry account (each rounded). */
  taxes: ComputedEntryTax[];
  taxTotal: number;
  /** net + taxTotal */
  gross: number;
}

export interface InvoiceTotals {
  /** Sum of pre-discount, pre-tax line values. */
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  /** Amount posted to A/R (invoice) or A/P (bill): sum of nets + taxes. */
  total: number;
  entries: ComputedEntry[];
  /** Tax aggregated per tax account across all lines. */
  taxByAccount: Array<{ accountGuid: string; amount: number }>;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/** Round half-away-from-zero to the currency fraction (100 => cents). */
export function roundCurrency(value: number, fraction: number = 100): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * fraction)) / fraction;
}

// ---------------------------------------------------------------------------
// Entry / invoice math
// ---------------------------------------------------------------------------

/**
 * Compute one entry's net, discount and tax values.
 * Mirrors gncEntryComputeValueInt (see module docblock for the algorithm).
 */
export function computeEntry(line: EntryLineInput, fraction: number = 100): ComputedEntry {
  const aggregate = line.quantity * line.price;

  const taxable = line.taxable !== false;
  const table = taxable && line.taxTable && line.taxTable.entries.length > 0 ? line.taxTable : null;

  // Aggregate tax-table percent (as a ratio) and fixed value.
  let tpercent = 0;
  let tvalue = 0;
  if (table) {
    for (const e of table.entries) {
      if (e.type === 'PERCENT') tpercent += e.amount;
      else tvalue += e.amount;
    }
  }
  tpercent /= 100;

  // Back out included tax: aggregate = pretax + pretax*tpercent + tvalue
  const taxIncluded = Boolean(table && line.taxIncluded);
  const pretax = taxIncluded ? (aggregate - tvalue) / (1 + tpercent) : aggregate;

  // Discount
  const discountHow: DiscountHow = line.discountHow ?? 'PRETAX';
  let discount = 0;
  const discAmt = line.discount ?? 0;
  if (discAmt !== 0) {
    const discountType: DiscountType = line.discountType ?? 'VALUE';
    if (discountType === 'VALUE') {
      discount = discAmt;
    } else if (discountHow === 'POSTTAX') {
      const taxOnPretax = table ? pretax * tpercent + tvalue : 0;
      discount = ((pretax + taxOnPretax) * discAmt) / 100;
    } else {
      // PRETAX and SAMETIME both compute the percent discount on the pretax value
      discount = (pretax * discAmt) / 100;
    }
  }

  const netRaw = pretax - discount;
  const net = roundCurrency(netRaw, fraction);
  const discountValue = roundCurrency(discount, fraction);

  // Tax base: PRETAX taxes the discounted value; SAMETIME/POSTTAX tax pretax.
  const taxBase = discountHow === 'PRETAX' ? netRaw : pretax;
  const taxes: ComputedEntryTax[] = [];
  let taxTotal = 0;
  if (table) {
    for (const e of table.entries) {
      const amt = roundCurrency(e.type === 'PERCENT' ? (taxBase * e.amount) / 100 : e.amount, fraction);
      if (amt !== 0) {
        taxes.push({ accountGuid: e.accountGuid, amount: amt });
        taxTotal += amt;
      }
    }
  }
  taxTotal = roundCurrency(taxTotal, fraction);

  return {
    subtotal: roundCurrency(pretax, fraction),
    discountValue,
    net,
    taxes,
    taxTotal,
    gross: roundCurrency(net + taxTotal, fraction),
  };
}

/**
 * Compute the full invoice: per-line values plus aggregated totals and
 * per-account tax aggregation (GnuCash accumulates tax splits by account).
 */
export function computeInvoiceTotals(lines: EntryLineInput[], fraction: number = 100): InvoiceTotals {
  const entries = lines.map((l) => computeEntry(l, fraction));

  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let total = 0;
  const taxMap = new Map<string, number>();

  for (const e of entries) {
    subtotal = roundCurrency(subtotal + e.subtotal, fraction);
    discountTotal = roundCurrency(discountTotal + e.discountValue, fraction);
    taxTotal = roundCurrency(taxTotal + e.taxTotal, fraction);
    total = roundCurrency(total + e.net + e.taxTotal, fraction);
    for (const t of e.taxes) {
      taxMap.set(t.accountGuid, roundCurrency((taxMap.get(t.accountGuid) ?? 0) + t.amount, fraction));
    }
  }

  return {
    subtotal,
    discountTotal,
    taxTotal,
    total,
    entries,
    taxByAccount: Array.from(taxMap.entries()).map(([accountGuid, amount]) => ({ accountGuid, amount })),
  };
}

// ---------------------------------------------------------------------------
// Posting split construction (pure)
// ---------------------------------------------------------------------------

export interface PostingSplitSpec {
  accountGuid: string;
  /** Signed decimal value for the split (GnuCash debit>0 / credit<0). */
  value: number;
  memo: string;
  action: string;
  /** True for the A/R (or A/P) split that carries the lot. */
  isPostSplit: boolean;
}

/**
 * Build the signed split values for an invoice/bill posting transaction.
 *
 * Customer invoice: +total on A/R; -net per line; -tax per tax account.
 * Vendor bill:      -total on A/P; +net per line; +tax per tax account.
 *
 * The line splits are per-entry (memo = entry description); tax splits are
 * accumulated per tax account — matching GnuCash's post with
 * "accumulate splits" unchecked (its default behavior for taxes is always
 * per-account accumulation).
 */
export function buildPostingSplits(
  kind: InvoiceKind,
  totals: InvoiceTotals,
  lines: EntryLineInput[],
  postAccountGuid: string,
  memo: string = '',
): PostingSplitSpec[] {
  const sign = kind === 'invoice' ? 1 : -1;
  const action = kind === 'invoice' ? 'Invoice' : 'Bill';

  const splits: PostingSplitSpec[] = [
    {
      accountGuid: postAccountGuid,
      value: sign * totals.total,
      memo,
      action,
      isPostSplit: true,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const computed = totals.entries[i];
    if (computed.net === 0) continue;
    splits.push({
      accountGuid: lines[i].accountGuid,
      value: -sign * computed.net,
      memo: lines[i].description ?? '',
      action,
      isPostSplit: false,
    });
  }

  for (const t of totals.taxByAccount) {
    if (t.amount === 0) continue;
    splits.push({
      accountGuid: t.accountGuid,
      value: -sign * t.amount,
      memo: '',
      action,
      isPostSplit: false,
    });
  }

  return splits;
}

// ---------------------------------------------------------------------------
// Amount due / payment allocation (pure)
// ---------------------------------------------------------------------------

/**
 * Amount still due for a posted invoice, derived from its lot's split values.
 * Invoice lots carry a positive A/R balance; bill lots a negative A/P balance.
 * Fully paid == 0.
 */
export function amountDueFromLotSplits(
  kind: InvoiceKind,
  splitValues: number[],
  fraction: number = 100,
): number {
  const balance = splitValues.reduce((sum, v) => sum + v, 0);
  return roundCurrency(kind === 'invoice' ? balance : -balance, fraction);
}

export interface OpenInvoiceForPayment {
  guid: string;
  /** Posting date used for oldest-first ordering; null sorts last. */
  datePosted: Date | null;
  amountDue: number;
}

export interface PaymentAllocation {
  invoiceGuid: string;
  amount: number;
}

export interface FifoAllocationResult {
  allocations: PaymentAllocation[];
  /** Unallocated remainder (0 when the payment fits in the open invoices). */
  remainder: number;
}

/**
 * Allocate a payment across open invoices oldest-first (GnuCash's default
 * auto-apply order). Closes invoices exactly when the payment covers them.
 */
export function allocatePaymentFifo(
  openInvoices: OpenInvoiceForPayment[],
  amount: number,
  fraction: number = 100,
): FifoAllocationResult {
  const epsilon = 0.5 / fraction;
  const sorted = [...openInvoices]
    .filter((i) => i.amountDue > epsilon)
    .sort((a, b) => {
      const ta = a.datePosted ? a.datePosted.getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.datePosted ? b.datePosted.getTime() : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
    });

  const allocations: PaymentAllocation[] = [];
  let remaining = roundCurrency(amount, fraction);
  for (const inv of sorted) {
    if (remaining <= epsilon) break;
    const take = roundCurrency(Math.min(inv.amountDue, remaining), fraction);
    allocations.push({ invoiceGuid: inv.guid, amount: take });
    remaining = roundCurrency(remaining - take, fraction);
  }

  return { allocations, remainder: remaining };
}

export interface PaymentSplitSpec {
  accountGuid: string;
  value: number;
  memo: string;
  action: string;
  /** Lot the split is assigned into (A/R–A/P splits only). */
  lotGuid: string | null;
}

/**
 * Build signed splits for a payment transaction.
 *
 * Customer payment: DEBIT (+) the deposit account; CREDIT (-) A/R per
 * allocation, each A/R split assigned into the paid invoice's lot.
 * Vendor payment flips the signs.
 */
export function buildPaymentSplits(
  kind: InvoiceKind,
  amount: number,
  transferAccountGuid: string,
  postAccountAllocations: Array<{ accountGuid: string; lotGuid: string; amount: number }>,
  memo: string = '',
): PaymentSplitSpec[] {
  const sign = kind === 'invoice' ? 1 : -1;
  const splits: PaymentSplitSpec[] = [
    {
      accountGuid: transferAccountGuid,
      value: sign * amount,
      memo,
      action: '',
      lotGuid: null,
    },
  ];
  for (const alloc of postAccountAllocations) {
    splits.push({
      accountGuid: alloc.accountGuid,
      value: -sign * alloc.amount,
      memo: '',
      action: 'Payment',
      lotGuid: alloc.lotGuid,
    });
  }
  return splits;
}

// ---------------------------------------------------------------------------
// Due date (billterms)
// ---------------------------------------------------------------------------

export interface BillTermSpec {
  /** 'GNC_TERM_TYPE_DAYS' | 'GNC_TERM_TYPE_PROXIMO' */
  type: string;
  duedays: number | null;
  cutoff: number | null;
}

function daysInMonthUTC(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Compute the due date for a posting date under a bill term
 * (gncBillTermComputeDueDate):
 *   DAYS    — due = post + duedays days.
 *   PROXIMO — due on day-of-month `duedays` of the next month; posts after
 *             the `cutoff` day roll one further month.
 * No term (or no duedays) => due immediately (the post date).
 */
export function computeDueDate(postDate: Date, term: BillTermSpec | null | undefined): Date {
  if (!term || term.duedays === null || term.duedays === undefined) {
    return new Date(postDate.getTime());
  }

  if (/PROXIMO/i.test(term.type)) {
    const year = postDate.getUTCFullYear();
    const month = postDate.getUTCMonth();
    const day = postDate.getUTCDate();
    let cutoff = term.cutoff ?? 0;
    if (cutoff <= 0) cutoff += daysInMonthUTC(year, month);
    const monthsAhead = day > cutoff ? 2 : 1;
    const targetMonth = month + monthsAhead;
    const targetYear = year + Math.floor(targetMonth / 12);
    const normMonth = ((targetMonth % 12) + 12) % 12;
    const dueDay = Math.min(term.duedays, daysInMonthUTC(targetYear, normMonth));
    return new Date(Date.UTC(targetYear, normMonth, dueDay, 12, 0, 0));
  }

  // GNC_TERM_TYPE_DAYS (default)
  return new Date(postDate.getTime() + term.duedays * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Invoice numbering
// ---------------------------------------------------------------------------

/**
 * Fallback numbering when the book has no 'counters/gncInvoice' (or gncBill)
 * slot: next = max numeric id across existing invoices of that kind, + 1.
 * Non-numeric ids are ignored.
 */
export function nextIdFromExisting(existingIds: string[]): number {
  let max = 0;
  for (const id of existingIds) {
    const n = parseInt(id, 10);
    if (Number.isFinite(n) && String(n) === id.replace(/^0+(?=\d)/, '') && n > max) max = n;
  }
  return max + 1;
}

/** GnuCash's default counter format is "%.6" PRIi64 — zero-padded to 6. */
export function formatInvoiceId(n: number): string {
  return String(n).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'overdue';

export function invoiceStatus(
  posted: boolean,
  amountDue: number,
  dueDate: Date | null,
  today: Date = new Date(),
  fraction: number = 100,
): InvoiceStatus {
  if (!posted) return 'draft';
  const epsilon = 0.5 / fraction;
  if (Math.abs(amountDue) <= epsilon) return 'paid';
  if (dueDate && dueDate.getTime() < today.getTime()) return 'overdue';
  return 'open';
}
