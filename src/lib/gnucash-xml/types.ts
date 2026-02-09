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
}

export interface GnuCashBook {
  id: string;
  idType: string;
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
}

export interface GnuCashTransaction {
  id: string;
  currency: { space: string; id: string };
  num?: string;
  datePosted: string;
  dateEntered: string;
  description: string;
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
}

export interface GnuCashBudget {
  id: string;
  name: string;
  description?: string;
  numPeriods: number;
  amounts: GnuCashBudgetAmount[];
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
  skipped: string[];
  warnings: string[];
}
