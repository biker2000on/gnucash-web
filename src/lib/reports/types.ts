/**
 * Report Type Definitions
 */

export enum ReportType {
  BALANCE_SHEET = 'balance_sheet',
  INCOME_STATEMENT = 'income_statement',
  CASH_FLOW = 'cash_flow',
  ACCOUNT_SUMMARY = 'account_summary',
  TRANSACTION_REPORT = 'transaction_report',
  TREASURER = 'treasurer',
  EQUITY_STATEMENT = 'equity_statement',
  TRIAL_BALANCE = 'trial_balance',
  GENERAL_JOURNAL = 'general_journal',
  GENERAL_LEDGER = 'general_ledger',
  INVESTMENT_PORTFOLIO = 'investment_portfolio',
  INVESTMENT_LOTS = 'investment_lots',
  RECONCILIATION = 'reconciliation',
  NET_WORTH_CHART = 'net_worth_chart',
  INCOME_EXPENSE_CHART = 'income_expense_chart',
  TAX_HARVESTING = 'tax_harvesting',
  CONTRIBUTION_SUMMARY = 'contribution_summary',
  INCOME_STATEMENT_BY_PERIOD = 'income_statement_by_period',
  NET_WORTH_BY_OWNER = 'net_worth_by_owner',
  BUDGET_REPORT = 'budget_report',
  SALES_BY_CUSTOMER = 'sales_by_customer',
  EXPENSES_BY_VENDOR = 'expenses_by_vendor',
  STOCK_VALUATION = 'stock_valuation',
  TAX_SCHEDULE = 'tax_schedule',
  BUDGET_INCOME_STATEMENT = 'budget_income_statement',
  BUDGET_BALANCE_SHEET = 'budget_balance_sheet',
  ACCOUNT_BREAKDOWN = 'account_breakdown',
  PRICE_HISTORY = 'price_history',
  DAY_OF_WEEK = 'day_of_week',
  AVERAGE_BALANCE = 'average_balance',
  NET_WORTH_ATTRIBUTION = 'net_worth_attribution',
  YEAR_IN_REVIEW = 'year_in_review',
  FX_REVALUATION = 'fx_revaluation',
  BLS_COMPARISON = 'bls_comparison',
}

export interface ReportConfig {
  type: ReportType;
  name: string;
  description: string;
  icon: string;
  category: 'financial' | 'account' | 'transaction' | 'investment' | 'business' | 'chart';
}

export interface ReportFilters {
  startDate: string | null;
  endDate: string | null;
  compareToPrevious?: boolean;
  accountTypes?: string[];
  showZeroBalances?: boolean;
  /** Book-scoped account GUIDs. When set, restrict queries to these accounts. */
  bookAccountGuids?: string[];
}

export interface LineItem {
  guid: string;
  name: string;
  amount: number;
  previousAmount?: number;
  children?: LineItem[];
  isTotal?: boolean;
  isSubtotal?: boolean;
  depth?: number;
}

export interface ReportSection {
  title: string;
  items: LineItem[];
  total: number;
  previousTotal?: number;
}

/** Base interface for all report data types */
export interface ReportDataBase {
  type: ReportType;
  title: string;
  generatedAt: string;
  filters: ReportFilters;
}

export interface TrialBalanceEntry {
  guid: string;
  accountPath: string;
  accountType: string;
  debit: number;
  credit: number;
}

export interface TrialBalanceData extends ReportDataBase {
  entries: TrialBalanceEntry[];
  totalDebits: number;
  totalCredits: number;
}

export interface JournalSplit {
  accountPath: string;
  debit: number;
  credit: number;
  memo: string;
}

export interface JournalEntry {
  transactionGuid: string;
  date: string;
  description: string;
  num: string;
  splits: JournalSplit[];
}

export interface GeneralJournalData extends ReportDataBase {
  entries: JournalEntry[];
  totalDebits: number;
  totalCredits: number;
  entryCount: number;
}

export interface LedgerEntry {
  date: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
  memo: string;
}

export interface LedgerAccount {
  guid: string;
  accountPath: string;
  accountType: string;
  openingBalance: number;
  entries: LedgerEntry[];
  closingBalance: number;
}

export interface GeneralLedgerData extends ReportDataBase {
  accounts: LedgerAccount[];
  totalDebits: number;
  totalCredits: number;
}

export interface PortfolioHolding {
  guid: string;
  accountName: string;
  symbol: string;
  shares: number;
  latestPrice: number;
  priceDate: string;
  marketValue: number;
  costBasis: number;
  gain: number;
  gainPercent: number;
}

export interface InvestmentPortfolioData extends ReportDataBase {
  holdings: PortfolioHolding[];
  totals: {
    marketValue: number;
    costBasis: number;
    gain: number;
    gainPercent: number;
  };
  showZeroShares: boolean;
}

export interface ChartDataPoint {
  date: string;
  [key: string]: string | number;
}

export interface ChartReportData extends ReportDataBase {
  dataPoints: ChartDataPoint[];
  series: string[];
}

export interface ReportData {
  type: ReportType;
  title: string;
  generatedAt: string;
  filters: ReportFilters;
  sections: ReportSection[];
  grandTotal?: number;
  previousGrandTotal?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Period-based income statement (Income / Expense columns per period)
// ─────────────────────────────────────────────────────────────────────────────

export type PeriodGrouping = 'month' | 'quarter' | 'year';

export interface PeriodColumn {
  label: string;     // e.g. "Jan 2026", "Q1 2026", "2026"
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface PeriodicLineItem {
  guid: string;
  name: string;
  /** Amount for each period column, same index as ReportData.periods */
  amounts: number[];
  /** Sum of amounts[] — cached on the server for convenience */
  total: number;
  children?: PeriodicLineItem[];
  depth?: number;
}

export interface PeriodicReportSection {
  title: string;
  items: PeriodicLineItem[];
  totals: number[];      // per-period section totals
  grandTotal: number;    // sum of totals across periods
}

export interface PeriodicReportData extends ReportDataBase {
  type: ReportType.INCOME_STATEMENT_BY_PERIOD;
  grouping: PeriodGrouping;
  periods: PeriodColumn[];
  sections: PeriodicReportSection[];
  /** Net income per period (income - expenses) */
  netByPeriod: number[];
  /** Sum of net income across all periods */
  netTotal: number;
}

// Available reports configuration
export const REPORTS: ReportConfig[] = [
  {
    type: ReportType.BALANCE_SHEET,
    name: 'Balance Sheet',
    description: 'Assets, liabilities, and equity at a point in time',
    icon: 'balance',
    category: 'financial',
  },
  {
    type: ReportType.INCOME_STATEMENT,
    name: 'Income Statement',
    description: 'Revenue and expenses over a period (Profit & Loss)',
    icon: 'trending',
    category: 'financial',
  },
  {
    type: ReportType.INCOME_STATEMENT_BY_PERIOD,
    name: 'Income Statement by Period',
    description: 'Income & expenses broken out by month, quarter, or year for side-by-side comparison',
    icon: 'trending',
    category: 'financial',
  },
  {
    type: ReportType.CASH_FLOW,
    name: 'Cash Flow Statement',
    description: 'Cash inflows and outflows by activity',
    icon: 'cash',
    category: 'financial',
  },
  {
    type: ReportType.ACCOUNT_SUMMARY,
    name: 'Account Summary',
    description: 'Summary of activity for selected accounts',
    icon: 'account',
    category: 'account',
  },
  {
    type: ReportType.TRANSACTION_REPORT,
    name: 'Transaction Report',
    description: 'Detailed list of transactions with filters',
    icon: 'list',
    category: 'transaction',
  },
  {
    type: ReportType.TREASURER,
    name: "Treasurer's Report",
    description: 'Monthly treasurer report with opening/closing balances, income and expense detail',
    icon: 'account',
    category: 'financial',
  },
  {
    type: ReportType.EQUITY_STATEMENT,
    name: 'Equity Statement',
    description: 'Changes in equity over a period',
    icon: 'balance',
    category: 'financial',
  },
  {
    type: ReportType.TRIAL_BALANCE,
    name: 'Trial Balance',
    description: 'Debit and credit balances for all accounts at a point in time',
    icon: 'balance',
    category: 'financial',
  },
  {
    type: ReportType.GENERAL_JOURNAL,
    name: 'General Journal',
    description: 'All transactions with debit/credit detail',
    icon: 'list',
    category: 'transaction',
  },
  {
    type: ReportType.GENERAL_LEDGER,
    name: 'General Ledger',
    description: 'Account-by-account transaction detail with running balances',
    icon: 'list',
    category: 'account',
  },
  {
    type: ReportType.INVESTMENT_PORTFOLIO,
    name: 'Investment Portfolio',
    description: 'Holdings with market value, cost basis, and gain/loss',
    icon: 'trending',
    category: 'investment',
  },
  {
    type: ReportType.INVESTMENT_LOTS,
    name: 'Investment Lots',
    description: 'Lot-level detail with realized/unrealized gains and holding period classification',
    icon: 'list',
    category: 'investment',
  },
  {
    type: ReportType.TAX_HARVESTING,
    name: 'Tax-Loss Harvesting',
    description: 'Identify tax-loss harvesting opportunities and wash sale risks',
    icon: 'scissors',
    category: 'investment',
  },
  {
    type: ReportType.CONTRIBUTION_SUMMARY,
    name: 'Contribution Summary',
    description: 'Retirement and brokerage account contributions with IRS limit tracking',
    icon: 'trending',
    category: 'investment',
  },
  {
    type: ReportType.BUDGET_REPORT,
    name: 'Budget Report',
    description: 'Budgeted vs actual amounts per account with income and expense subtotals',
    icon: 'account',
    category: 'financial',
  },
  {
    type: ReportType.BUDGET_INCOME_STATEMENT,
    name: 'Budget Income Statement',
    description: 'Budgeted vs actual P&L with favorable/unfavorable variances and per-period barchart',
    icon: 'trending',
    category: 'financial',
  },
  {
    type: ReportType.BUDGET_BALANCE_SHEET,
    name: 'Budget Balance Sheet',
    description: 'Projected balances at the end of a budget period — opening balances plus budgeted flows',
    icon: 'balance',
    category: 'financial',
  },
  {
    type: ReportType.SALES_BY_CUSTOMER,
    name: 'Sales by Customer',
    description: 'Posted customer invoice totals per customer with tax, payments, and balance',
    icon: 'trending',
    category: 'business',
  },
  {
    type: ReportType.EXPENSES_BY_VENDOR,
    name: 'Expenses by Vendor',
    description: 'Posted vendor bill totals per vendor with amounts paid and outstanding balance',
    icon: 'cash',
    category: 'business',
  },
  {
    type: ReportType.STOCK_VALUATION,
    name: 'Stock Valuation',
    description: 'Inventory on hand per item with valuation method, unit cost, and extended value',
    icon: 'balance',
    category: 'business',
  },
  {
    type: ReportType.NET_WORTH_BY_OWNER,
    name: 'Net Worth by Owner',
    description: 'Assets, liabilities, and net worth grouped by owner (self, spouse, joint)',
    icon: 'balance',
    category: 'financial',
  },
  {
    type: ReportType.RECONCILIATION,
    name: 'Reconciliation Report',
    description: 'Reconciled, cleared, and uncleared transactions by account',
    icon: 'balance',
    category: 'account',
  },
  {
    type: ReportType.NET_WORTH_CHART,
    name: 'Net Worth Chart',
    description: 'Assets, liabilities, and net worth over time',
    icon: 'trending',
    category: 'chart',
  },
  {
    type: ReportType.INCOME_EXPENSE_CHART,
    name: 'Income & Expense Chart',
    description: 'Monthly income and expenses over time',
    icon: 'cash',
    category: 'chart',
  },
  {
    type: ReportType.ACCOUNT_BREAKDOWN,
    name: 'Account Breakdown',
    description: 'Assets, liabilities, income, or expenses grouped by account at a chosen depth — pie or bar',
    icon: 'cash',
    category: 'chart',
  },
  {
    type: ReportType.PRICE_HISTORY,
    name: 'Price History',
    description: 'Commodity price history from the GnuCash price database',
    icon: 'trending',
    category: 'chart',
  },
  {
    type: ReportType.DAY_OF_WEEK,
    name: 'Income & Expenses by Day of Week',
    description: 'Totals and daily averages of income and expense flows by weekday',
    icon: 'cash',
    category: 'chart',
  },
  {
    type: ReportType.AVERAGE_BALANCE,
    name: 'Average Balance',
    description: 'Average daily balance, minimum, maximum, and ending balance per month for selected cash accounts',
    icon: 'balance',
    category: 'account',
  },
  {
    type: ReportType.NET_WORTH_ATTRIBUTION,
    name: 'Net-Worth Attribution',
    description: 'Decomposes net-worth change into savings, market gains, debt paydown, and other — summing exactly to the total',
    icon: 'trending',
    category: 'chart',
  },
  {
    type: ReportType.YEAR_IN_REVIEW,
    name: 'Year in Review',
    description: 'Annual wrapped: net worth arc, savings rate, top categories, dividends, best/worst holdings, streaks',
    icon: 'trending',
    category: 'financial',
  },
  {
    type: ReportType.FX_REVALUATION,
    name: 'FX Revaluation',
    description: 'Foreign-currency holdings with average acquisition rates and unrealized/realized FX gains',
    icon: 'cash',
    category: 'financial',
  },
  {
    type: ReportType.BLS_COMPARISON,
    name: 'Spending vs National Averages',
    description: 'Your categories vs BLS Consumer Expenditure Survey averages for your household size',
    icon: 'cash',
    category: 'chart',
  },
];

// Get report config by type
export function getReportConfig(type: ReportType): ReportConfig | undefined {
  return REPORTS.find(r => r.type === type);
}

export interface TreasurerReportData {
  header: {
    organization: string;
    roleName: string;
    personName: string;
    reportDate: string;
    periodStart: string;
    periodEnd: string;
  };
  openingBalance: {
    accounts: Array<{ name: string; balance: number }>;
    total: number;
  };
  incomeSummary: {
    transactions: Array<{
      date: string;
      description: string;
      category: string;
      amount: number;
    }>;
    total: number;
  };
  expenseSummary: {
    transactions: Array<{
      date: string;
      description: string;
      category: string;
      amount: number;
    }>;
    total: number;
  };
  closingBalance: {
    accounts: Array<{ name: string; balance: number }>;
    total: number;
  };
}

/** Saved report configuration stored in the database */
export interface SavedReport {
  id: number;
  userId: number;
  baseReportType: ReportType;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  filters: ReportFilters | null;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Treasurer-specific config stored in SavedReport.config */
export interface TreasurerReportConfig {
  accountGuids?: string[];
  accountTypes?: string[];
  organization?: string;
  roleName?: string;
  personName?: string;
}

/** Input for creating/updating a saved report */
export interface SavedReportInput {
  baseReportType: ReportType;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  filters?: ReportFilters;
  isStarred?: boolean;
}

export interface ContributionLineItem {
  splitGuid: string;
  date: string;
  description: string;
  amount: number;
  type: string;
  taxYear: number;
  sourceAccountName: string;
}

export interface ContributionIrsLimit {
  base: number;
  catchUp: number;
  total: number;
  percentUsed: number;
}

export interface AccountContributionSummary {
  accountGuid: string;
  accountName: string;
  accountPath: string;
  retirementAccountType: string | null;
  contributions: number;
  employerMatch: number;
  incomeContributions: number;
  transfers: number;
  withdrawals: number;
  /** Fees paid out of the account (negative). Excluded from netContributions. */
  fees: number;
  /**
   * contributions + employerMatch + incomeContributions + withdrawals.
   * Transfers/rollovers and fees are excluded so a rollover never inflates
   * (or deflates) contributions.
   */
  netContributions: number;
  irsLimit: ContributionIrsLimit | null;
  transactions: ContributionLineItem[];
}

/** Rollup of contribution activity for one retirement account type (401k, hsa, ...) */
export interface AccountTypeContributionSummary {
  contributions: number;
  employerMatch: number;
  incomeContributions: number;
  transfers: number;
  withdrawals: number;
  fees: number;
  /** Same convention as per-account netContributions (transfers/fees excluded) */
  net: number;
  /** Employee-deferral limit for this type (null where no federal limit exists) */
  irsLimit: ContributionIrsLimit | null;
}

export interface ContributionSummaryData extends ReportDataBase {
  type: ReportType.CONTRIBUTION_SUMMARY;
  groupBy: 'tax_year' | 'calendar_year';
  periods: Array<{
    year: number;
    accounts: AccountContributionSummary[];
    /** Keyed by retirement_account_type ('401k', 'traditional_ira', 'hsa', ...) */
    byAccountType: Record<string, AccountTypeContributionSummary>;
    totalContributions: number;
    totalIncomeContributions: number;
    totalEmployerMatch: number;
    totalTransfers: number;
    totalWithdrawals: number;
    totalFees: number;
    totalNetContributions: number;
  }>;
  grandTotalContributions: number;
  grandTotalIncomeContributions: number;
  grandTotalEmployerMatch: number;
  grandTotalTransfers: number;
  grandTotalNetContributions: number;
}

// Group reports by category
export function getReportsByCategory(): Record<string, ReportConfig[]> {
  return REPORTS.reduce((acc, report) => {
    if (!acc[report.category]) {
      acc[report.category] = [];
    }
    acc[report.category].push(report);
    return acc;
  }, {} as Record<string, ReportConfig[]>);
}
