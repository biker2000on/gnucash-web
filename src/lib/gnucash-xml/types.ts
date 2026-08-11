/**
 * TypeScript types for GnuCash XML elements
 */

export interface GnuCashXmlData {
  book: GnuCashBook;
  commodities: GnuCashCommodity[];
  pricedb: GnuCashPrice[];
  accounts: GnuCashAccount[];
  transactions: GnuCashTransaction[];
  budgets: GnuCashBudget[];
  /** gnc:schedxaction elements (version 2.0.0). */
  schedxactions?: GnuCashSchedXAction[];
  /**
   * gnc:template-transactions — the template account tree (template ROOT
   * first) and the template transactions living on those accounts. The
   * accounts use the `template` namespace commodity; the splits carry the
   * sched-xaction KVP frame in split:slots.
   */
  templateAccounts?: GnuCashAccount[];
  templateTransactions?: GnuCashTransaction[];
  /** gnc:GncBillTerm elements (§2.20). */
  billterms?: GnuCashBillTerm[];
  /** gnc:GncTaxTable elements with nested entries (§2.21). */
  taxtables?: GnuCashTaxTable[];
  /** gnc:GncCustomer elements (§2.13). */
  customers?: GnuCashCustomer[];
  /** gnc:GncVendor elements (§2.14). */
  vendors?: GnuCashVendor[];
  /** gnc:GncEmployee elements (§2.15). */
  employees?: GnuCashEmployee[];
  /** gnc:GncJob elements (§2.16). */
  jobs?: GnuCashJob[];
  /** gnc:GncInvoice elements (§2.17) — invoices, bills, credit notes, vouchers. */
  invoices?: GnuCashInvoice[];
  /** gnc:GncEntry elements (§2.18) — invoice/bill/order line items. */
  entries?: GnuCashEntry[];
  /** gnc:GncOrder elements (§2.19). */
  orders?: GnuCashOrder[];
  countData: Record<string, number>;
  /**
   * Parse-time notes about content that was recognized but not modeled
   * (e.g. binary slot values). Merged into ImportSummary.skipped so
   * nothing is ever silently dropped.
   */
  skipped?: string[];
}

export interface GnuCashBook {
  id: string;
  idType: string;
  slots?: GnuCashSlot[];
}

/**
 * Typed KVP slot value. String-ish payloads keep their XML wire form
 * (integer as decimal text so int64 survives, numeric as "num/denom",
 * timespec as "YYYY-MM-DD HH:MM:SS +0000", gdate as "YYYY-MM-DD").
 * The codec in slots.ts converts to/from XML and native slots-table rows.
 */
export type SlotValue =
  | { type: 'integer'; value: string }
  | { type: 'double'; value: number }
  | { type: 'numeric'; value: string }
  | { type: 'string'; value: string }
  | { type: 'guid'; value: string }
  | { type: 'timespec'; value: string }
  | { type: 'gdate'; value: string }
  | { type: 'list'; values: SlotValue[] }
  | { type: 'frame'; slots: GnuCashSlot[] };

export interface GnuCashSlot {
  key: string;
  value: SlotValue;
}

export interface GnuCashLot {
  id: string;
  /** lot:slots — title, notes, gncInvoice frame, etc. */
  slots?: GnuCashSlot[];
}

export interface GnuCashCommodity {
  space: string; // namespace like "CURRENCY", "NYSE", "NASDAQ"
  id: string;    // mnemonic like "USD", "AAPL"
  name?: string;
  xcode?: string;
  fraction: number;
  quoteFlag?: number;
  quoteSource?: string;
  quoteTz?: string;
  slots?: GnuCashSlot[];
}

export interface GnuCashPrice {
  id: string;
  commodity: { space: string; id: string };
  currency: { space: string; id: string };
  date: string;
  source: string;
  type?: string;
  value: string; // fraction string like "1234/100"
}

export interface GnuCashAccount {
  name: string;
  id: string;
  type: string;
  commodity?: { space: string; id: string };
  commodityScu?: number;
  description?: string;
  parentId?: string;
  hidden?: boolean;
  placeholder?: boolean;
  notes?: string;
  code?: string;
  /** act:non-standard-scu empty-element flag. */
  nonStdScu?: boolean;
  /** Full act:slots frame (hidden/placeholder/notes column mirrors stay). */
  slots?: GnuCashSlot[];
  /** act:lots — gnc:lot children with their lot:slots. */
  lots?: GnuCashLot[];
}

export interface GnuCashTransaction {
  id: string;
  currency: { space: string; id: string };
  num?: string;
  datePosted: string;
  dateEntered: string;
  description: string;
  /** trn:slots — incl. the date-posted gdate slot, notes, void data, etc. */
  slots?: GnuCashSlot[];
  splits: GnuCashSplit[];
}

export interface GnuCashSplit {
  id: string;
  reconciledState: string;
  reconcileDate?: string;
  value: string;    // fraction "1234/100"
  quantity: string;  // fraction "1234/100"
  accountId: string;
  memo?: string;
  action?: string;
  lotId?: string;
  /** split:slots — gains-source/gains-split links, sched-xaction frame, etc. */
  slots?: GnuCashSlot[];
}

/**
 * gnc:recurrence version 1.0.0 (shared by bgt:recurrence and sx:schedule).
 */
export interface GnuCashRecurrence {
  mult: number;
  periodType: string;
  periodStart: string; // YYYY-MM-DD
  /** recurrence:weekend_adj — only set when not "none" (2.2 compat). */
  weekendAdjust?: string;
}

/**
 * sx:deferredInstance — a postponed SX occurrence. The native SQL schema
 * has no representation for these (gnc-schedxaction-sql.cpp persists no
 * deferred-instance data), so on import they are recorded as skipped.
 */
export interface GnuCashSxDeferredInstance {
  /** sx:last gdate — optional (only when the last-occur date is valid). */
  last?: string;
  remOccur?: number;
  instanceCount?: number;
}

/** gnc:schedxaction version 2.0.0 (see schema inventory §2.6). */
export interface GnuCashSchedXAction {
  id: string;
  name: string;
  /** sx:enabled y/n — optional in the parser, defaults to enabled. */
  enabled: boolean;
  autoCreate: boolean;
  autoCreateNotify: boolean;
  advanceCreateDays: number;
  advanceRemindDays: number;
  instanceCount: number;
  /** sx:start gdate YYYY-MM-DD. */
  start: string;
  /** sx:last gdate — only when a last-occur date is valid. */
  last?: string;
  /**
   * End condition trio (mutually exclusive): either numOccur + remOccur,
   * or end, or neither (no end).
   */
  numOccur?: number;
  remOccur?: number;
  end?: string;
  /** sx:templ-acct — guid of the template account under template-transactions. */
  templateAccountId: string;
  /** sx:schedule — one or more gnc:recurrence (composite schedules have 2+). */
  schedule: GnuCashRecurrence[];
  deferredInstances?: GnuCashSxDeferredInstance[];
  /** sx:slots — KVP passthrough. */
  slots?: GnuCashSlot[];
}

export interface GnuCashBudget {
  id: string;
  name: string;
  description?: string;
  numPeriods: number;
  recurrence?: GnuCashRecurrence;
  amounts: GnuCashBudgetAmount[];
  /** Non-amount bgt:slots (per-period notes frames, etc.). */
  slots?: GnuCashSlot[];
}

export interface GnuCashBudgetAmount {
  accountId: string;
  periodNum: number;
  amount: string; // fraction string
}

/* ============================================================
 * Business object families (schema inventory §2.11–§2.21)
 * ============================================================ */

/**
 * Address sub-element (§2.11) — cust:addr / cust:shipaddr / vendor:addr /
 * employee:addr. Version 2.0.0; every field emitted only when non-empty.
 * The native DB flattens these into addr_* / shipaddr_* columns; addr:slots
 * has no column (the native SQL backend drops it too) and is recorded as
 * skipped on import.
 */
export interface GnuCashAddress {
  name?: string;
  addr1?: string;
  addr2?: string;
  addr3?: string;
  addr4?: string;
  phone?: string;
  fax?: string;
  email?: string;
  slots?: GnuCashSlot[];
}

/**
 * Owner sub-element (§2.12) — owner:type (QOF id string: gncCustomer,
 * gncJob, gncVendor, gncEmployee) + owner:id guid. Maps to the native
 * owner_type int (2/3/4/5) + owner_guid column pairs.
 */
export interface GnuCashOwner {
  type: string;
  id: string;
}

/** billterm:days variant — all fields maybe_add (zeros omitted). */
export interface GnuCashBillTermDays {
  dueDays?: number;
  discountDays?: number;
  /** bt-days:discount numeric. */
  discount?: string;
}

/** billterm:proximo variant — all fields maybe_add (zeros omitted). */
export interface GnuCashBillTermProximo {
  dueDay?: number;
  discountDay?: number;
  /** bt-prox:discount numeric. */
  discount?: string;
  cutoffDay?: number;
}

/**
 * gnc:GncBillTerm (§2.20). Exactly one of days/proximo is present; the
 * variant doubles as the native billterms.type discriminator
 * (GNC_TERM_TYPE_DAYS / GNC_TERM_TYPE_PROXIMO).
 */
export interface GnuCashBillTerm {
  guid: string;
  name: string;
  description: string;
  refcount: number;
  /** billterm:invisible 0/1 int. */
  invisible: boolean;
  /** billterm:child — NOT persisted natively (no column, matching SQL backend). */
  childId?: string;
  parentId?: string;
  days?: GnuCashBillTermDays;
  proximo?: GnuCashBillTermProximo;
  slots?: GnuCashSlot[];
}

/** gnc:GncTaxTableEntry — no version attribute. */
export interface GnuCashTaxTableEntry {
  accountId?: string;
  /** tte:amount numeric. */
  amount: string;
  /** tte:type — VALUE | PERCENT (native taxtable_entries.type 1/2). */
  type: string;
}

/** gnc:GncTaxTable (§2.21). */
export interface GnuCashTaxTable {
  guid: string;
  name: string;
  refcount: number;
  invisible: boolean;
  /** taxtable:child — NOT persisted natively (no column, matching SQL backend). */
  childId?: string;
  parentId?: string;
  entries: GnuCashTaxTableEntry[];
  slots?: GnuCashSlot[];
}

/** gnc:GncCustomer (§2.13). */
export interface GnuCashCustomer {
  guid: string;
  name: string;
  /** cust:id — the human-facing number, e.g. "000001". */
  id: string;
  addr: GnuCashAddress;
  shipaddr: GnuCashAddress;
  notes?: string;
  /** cust:terms — billterm guid. */
  termsId?: string;
  /** cust:taxincluded — YES | NO | USEGLOBAL (native tax_included int 1/2/3). */
  taxIncluded: string;
  /** cust:active 0/1 int. */
  active: boolean;
  /** cust:discount numeric (always emitted, even zero). */
  discount: string;
  /** cust:credit numeric (always emitted, even zero). */
  credit: string;
  currency: { space: string; id: string };
  /** cust:use-tt 0/1 int (native tax_override). */
  useTaxTable: boolean;
  taxTableId?: string;
  slots?: GnuCashSlot[];
}

/** gnc:GncVendor (§2.14) — customer minus shipaddr/discount/credit. */
export interface GnuCashVendor {
  guid: string;
  name: string;
  id: string;
  addr: GnuCashAddress;
  notes?: string;
  termsId?: string;
  /** vendor:taxincluded — YES | NO | USEGLOBAL (native tax_inc string). */
  taxIncluded: string;
  active: boolean;
  currency: { space: string; id: string };
  useTaxTable: boolean;
  taxTableId?: string;
  slots?: GnuCashSlot[];
}

/** gnc:GncEmployee (§2.15). */
export interface GnuCashEmployee {
  guid: string;
  username: string;
  id: string;
  addr: GnuCashAddress;
  language?: string;
  acl?: string;
  active: boolean;
  /** employee:workday numeric (always emitted). */
  workday: string;
  /** employee:rate numeric (always emitted). */
  rate: string;
  currency: { space: string; id: string };
  /** employee:ccard — credit-card account guid. */
  ccardId?: string;
  slots?: GnuCashSlot[];
}

/** gnc:GncJob (§2.16) — owned by a customer or vendor. */
export interface GnuCashJob {
  guid: string;
  id: string;
  name: string;
  reference?: string;
  /** job:owner — required in the writer; optional here for robust reads. */
  owner?: GnuCashOwner;
  active: boolean;
  slots?: GnuCashSlot[];
}

/** gnc:GncInvoice (§2.17). */
export interface GnuCashInvoice {
  guid: string;
  id: string;
  owner?: GnuCashOwner;
  /** invoice:opened timespec. */
  opened: string;
  /** invoice:posted timespec — only when posted. */
  posted?: string;
  termsId?: string;
  billingId?: string;
  notes?: string;
  active: boolean;
  /** invoice:posttxn — the posting gnc:transaction guid (posted only). */
  postTxnId?: string;
  /** invoice:postlot — the AR/AP lot guid (posted only). */
  postLotId?: string;
  /** invoice:postacc — the AR/AP account guid (posted only). */
  postAccId?: string;
  currency: { space: string; id: string };
  billTo?: GnuCashOwner;
  /** invoice:charge-amt numeric — only when non-zero. */
  chargeAmt?: string;
  slots?: GnuCashSlot[];
}

/** gnc:GncEntry (§2.18) — line items with per-side i- and b- fields. */
export interface GnuCashEntry {
  guid: string;
  /** entry:date timespec. */
  date: string;
  /** entry:entered timespec. */
  entered?: string;
  description?: string;
  action?: string;
  notes?: string;
  /** entry:qty numeric — non-zero only. */
  quantity?: string;
  /* Customer-invoice side. */
  iAcctId?: string;
  iPrice?: string;
  iDiscount?: string;
  invoiceId?: string;
  /** entry:i-disc-type — VALUE | PERCENT (inside invoice block). */
  iDiscType?: string;
  /** entry:i-disc-how — PRETAX | SAMETIME | POSTTAX (inside invoice block). */
  iDiscHow?: string;
  iTaxable?: boolean;
  iTaxIncluded?: boolean;
  iTaxTableId?: string;
  /* Vendor-bill side. */
  bAcctId?: string;
  bPrice?: string;
  billId?: string;
  billable?: boolean;
  billTo?: GnuCashOwner;
  bTaxable?: boolean;
  bTaxIncluded?: boolean;
  /** entry:b-pay — CASH | CARD (native b_paytype 1/2, employee vouchers). */
  bPayment?: string;
  bTaxTableId?: string;
  orderId?: string;
  slots?: GnuCashSlot[];
}

/** gnc:GncOrder (§2.19). */
export interface GnuCashOrder {
  guid: string;
  id: string;
  owner?: GnuCashOwner;
  opened: string;
  /** order:closed timespec — only when set. */
  closed?: string;
  notes?: string;
  reference?: string;
  active: boolean;
  slots?: GnuCashSlot[];
}

export interface ImportSummary {
  commodities: number;
  accounts: number;
  transactions: number;
  splits: number;
  prices: number;
  budgets: number;
  budgetAmounts: number;
  /** Native slots-table rows written (KVP passthrough). */
  slots: number;
  /** Lot rows written (declared act:lots plus split:lot inferences). */
  lots: number;
  /** Scheduled transactions imported (schedxactions rows). */
  schedxactions: number;
  /** Business objects imported (native billterms rows). */
  billterms: number;
  /** Tax tables imported (taxtables rows; entries ride along). */
  taxtables: number;
  customers: number;
  vendors: number;
  employees: number;
  jobs: number;
  invoices: number;
  /** Invoice/bill/order line items imported (entries rows). */
  entries: number;
  orders: number;
  skipped: string[];
  warnings: string[];
  bookGuid?: string;
}
