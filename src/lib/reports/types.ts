/**
 * Report Type Definitions
 */

export enum ReportType {
  BALANCE_SHEET = 'balance_sheet',
  INCOME_STATEMENT = 'income_statement',
  CASH_FLOW = 'cash_flow',
  ACCOUNT_SUMMARY = 'account_summary',
  TRANSACTION_REPORT = 'transaction_report',
}

export interface ReportConfig {
  type: ReportType;
  name: string;
  description: string;
  icon: string;
  category: 'financial' | 'account' | 'transaction';
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
];

// Get report config by type
export function getReportConfig(type: ReportType): ReportConfig | undefined {
  return REPORTS.find(r => r.type === type);
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
