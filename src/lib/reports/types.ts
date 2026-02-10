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
  RECONCILIATION = 'reconciliation',
  NET_WORTH_CHART = 'net_worth_chart',
  INCOME_EXPENSE_CHART = 'income_expense_chart',
}

export interface ReportConfig {
  type: ReportType;
  name: string;
  description: string;
  icon: string;
  category: 'financial' | 'account' | 'transaction' | 'investment' | 'chart';
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
