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

export interface GnuCashBudget {
  id: string;
  name: string;
  description?: string;
  numPeriods: number;
  recurrence?: {
    mult: number;
    periodType: string;
    periodStart: string; // YYYY-MM-DD
    /** recurrence:weekend_adj — only set when not "none" (2.2 compat). */
    weekendAdjust?: string;
  };
  amounts: GnuCashBudgetAmount[];
  /** Non-amount bgt:slots (per-period notes frames, etc.). */
  slots?: GnuCashSlot[];
}

export interface GnuCashBudgetAmount {
  accountId: string;
  periodNum: number;
  amount: string; // fraction string
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
  skipped: string[];
  warnings: string[];
  bookGuid?: string;
}
