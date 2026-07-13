/**
 * Feature registry — the single source of truth for every destination in the
 * app. Powers the sidebar (task-oriented domains), the command palette, the
 * /catalog directory, the domain hub pages, and Related-links strips.
 *
 * Adding a feature = one entry here; nav, palette, and catalog pick it up.
 */

export type FeatureDomain =
    | 'home'
    | 'money'
    | 'budgets'
    | 'investments'
    | 'taxes'
    | 'planning'
    | 'reports'
    | 'business'
    | 'settings';

export type FeatureKind = 'page' | 'report' | 'tool' | 'action';

export interface Feature {
    /** Stable id (also used by the palette and pinning). */
    id: string;
    title: string;
    /** One-line "why you'd use this" shown in catalog/hubs. */
    description: string;
    href: string;
    domain: FeatureDomain;
    /** Task-group heading inside the domain hub / catalog. */
    task: string;
    kind: FeatureKind;
    keywords?: string;
    shortcut?: string;
    /** Only shown in the mobile sidebar. */
    mobileOnly?: boolean;
    /** Only relevant on business-entity books. */
    businessOnly?: boolean;
    /** Appears as a sidebar child entry (hubs list everything regardless). */
    nav?: boolean;
    /** Shorter label for the sidebar (falls back to title). */
    navTitle?: string;
}

export const DOMAIN_LABELS: Record<FeatureDomain, string> = {
    home: 'Home',
    money: 'Money',
    budgets: 'Budgets & Goals',
    investments: 'Investments',
    taxes: 'Taxes',
    planning: 'Planning',
    reports: 'Reports',
    business: 'Business',
    settings: 'Settings',
};

export const FEATURES: Feature[] = [
    // ── Home ─────────────────────────────────────────────────────────────
    { id: 'nav-dashboard', title: 'Dashboard', description: 'Composable overview: net worth, cash flow, budgets, insights, and custom widgets.', href: '/dashboard', domain: 'home', task: 'Overview', kind: 'page', shortcut: 'g d', nav: true },

    // ── Money: everyday accounting ───────────────────────────────────────
    { id: 'nav-accounts', title: 'Account Hierarchy', description: 'The full chart of accounts with balances and dual-column investment views.', href: '/accounts', domain: 'money', task: 'Accounts & ledgers', kind: 'page', keywords: 'tree chart of accounts', shortcut: 'g a', nav: true },
    { id: 'nav-ledger', title: 'General Ledger', description: 'Every transaction with search, #tag filters, bulk editing, and running balances.', href: '/ledger', domain: 'money', task: 'Accounts & ledgers', kind: 'page', keywords: 'transactions journal', shortcut: 'g l', nav: true },
    { id: 'nav-quick-add', title: 'Quick Add', description: 'Thumb-first capture with an offline queue — record it while you are still in line.', href: '/quick-add', domain: 'money', task: 'Accounts & ledgers', kind: 'page', keywords: 'capture expense mobile offline fast entry magic', mobileOnly: true, nav: true },
    { id: 'nav-tags', title: 'Tags', description: 'Cross-cutting labels for transactions and accounts, with #tag search everywhere.', href: '/tags', domain: 'money', task: 'Accounts & ledgers', kind: 'page', shortcut: 'g t', nav: true },
    { id: 'nav-scheduled', title: 'Scheduled Transactions', description: 'Recurring transactions with execute/skip, batch catch-up, and mortgage-aware amounts.', href: '/scheduled-transactions', domain: 'money', task: 'Accounts & ledgers', kind: 'page', keywords: 'recurring sx', nav: true },
    { id: 'nav-receipts', title: 'Receipts', description: 'Drag-and-drop or camera capture with OCR and auto-matching to transactions.', href: '/receipts', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'uploads', nav: true },
    { id: 'nav-payslips', title: 'Payslips', description: 'PDF paystubs extracted into full split transactions — taxes and deductions itemized.', href: '/payslips', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'uploads paycheck payroll', nav: true },
    { id: 'nav-statements', title: 'Statements', description: 'Upload bank statements (PDF/CSV/OFX), auto-match, and reconcile to the closing balance.', href: '/statements', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'uploads reconcile bank', nav: true },
    { id: 'nav-import-export', title: 'Import / Export', description: 'GnuCash XML round-trip, Amazon order import, and desktop-compatible exports.', href: '/import-export', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'xml amazon backup', nav: true },
    { id: 'nav-qif-import', title: 'QIF Import', description: 'Quicken files with transfer matching, category mapping, and duplicate detection.', href: '/import-export/qif', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'quicken import bank transfer' },

    // ── Budgets & Goals ──────────────────────────────────────────────────
    { id: 'nav-budgets', title: 'Budgets', description: 'Envelope budgeting with rollover, pace markers, overspend alerts, and scenarios.', href: '/budgets', domain: 'budgets', task: 'Budgeting', kind: 'page', shortcut: 'g u', nav: true },
    { id: 'nav-goals', title: 'Goals', description: 'Emergency-fund, savings, and debt-payoff goals with projected completion dates.', href: '/goals', domain: 'budgets', task: 'Budgeting', kind: 'page', keywords: 'savings targets', shortcut: 'g o', nav: true },
    { id: 'rpt-budget', title: 'Budget Report', description: 'Budgeted vs actual per account with income and expense subtotals.', href: '/reports/budget_report', domain: 'budgets', task: 'Budget reports', kind: 'report', keywords: 'budgeted actual variance' },
    { id: 'rpt-budget-income', title: 'Budget Income Statement', description: 'The monthly read: budget-vs-actual P&L with favorable/unfavorable variances.', href: '/reports/budget_income_statement', domain: 'budgets', task: 'Budget reports', kind: 'report', keywords: 'budget pnl variance favorable' },
    { id: 'rpt-budget-bs', title: 'Budget Balance Sheet', description: 'Projected balances at the end of a budget period.', href: '/reports/budget_balance_sheet', domain: 'budgets', task: 'Budget reports', kind: 'report', keywords: 'projected balances budget' },

    // ── Investments ──────────────────────────────────────────────────────
    { id: 'nav-investments', title: 'Holdings', description: 'Portfolio market value, cost basis, unrealized gains, and sector exposure.', href: '/investments', domain: 'investments', task: 'Portfolio', kind: 'page', keywords: 'portfolio stocks', shortcut: 'g i', nav: true },
    { id: 'nav-inv-cash', title: 'Investment Cash', navTitle: 'Cash', description: 'Cash sitting in brokerage and retirement accounts.', href: '/investments/cash', domain: 'investments', task: 'Portfolio', kind: 'page', nav: true },
    { id: 'nav-inv-accounts', title: 'Investment Accounts', navTitle: 'Accounts', description: 'Per-account performance with time-weighted returns.', href: '/investments/accounts', domain: 'investments', task: 'Portfolio', kind: 'page', nav: true },
    { id: 'nav-inv-rebalancing', title: 'Rebalancing', description: 'Per-symbol or per-sector targets with drift bands and tax-aware sell ordering.', href: '/investments/rebalancing', domain: 'investments', task: 'Strategy', kind: 'page', keywords: 'allocation drift', nav: true },
    { id: 'nav-inv-benchmark', title: 'Benchmark', description: 'Your time-weighted return vs S&P 500, Dow, NASDAQ, and Russell 2000.', href: '/investments/benchmark', domain: 'investments', task: 'Strategy', kind: 'page', keywords: 'sp500 index compare', nav: true },
    { id: 'nav-inv-dividends', title: 'Dividends', description: 'Trailing income, yield on cost, monthly chart, and a forward payment calendar.', href: '/investments/dividends', domain: 'investments', task: 'Income', kind: 'page', keywords: 'income yield calendar', nav: true },
    { id: 'nav-inv-equity-comp', title: 'Equity Compensation', description: 'RSU vests and ESPP purchases posted with correct FMV basis — no double taxation.', href: '/investments/equity-comp', domain: 'investments', task: 'Income', kind: 'page', keywords: 'rsu espp vest stock options sell to cover', nav: true },
    { id: 'nav-inv-fixed-income', title: 'Fixed Income', description: 'Bond/CD/Treasury ladder with YTM, maturity calendar, and coupon estimates.', href: '/investments/fixed-income', domain: 'investments', task: 'Income', kind: 'page', keywords: 'bonds cd treasury maturity ytm ladder coupon', nav: true },
    { id: 'nav-inv-price-alerts', title: 'Price Alerts', description: 'Get notified when a holding crosses a target price.', href: '/investments/price-alerts', domain: 'investments', task: 'Strategy', kind: 'page', keywords: 'target price notification threshold watch', nav: true },
    { id: 'rpt-portfolio', title: 'Investment Portfolio Report', description: 'Holdings with market value, cost basis, and gain/loss.', href: '/reports/investment_portfolio', domain: 'investments', task: 'Reports', kind: 'report' },
    { id: 'rpt-lots', title: 'Investment Lots', description: 'Lot-level detail with realized/unrealized gains and holding periods.', href: '/reports/investment_lots', domain: 'investments', task: 'Reports', kind: 'report', keywords: 'cost basis gains' },
    { id: 'rpt-stock-valuation', title: 'Stock Valuation', description: 'Inventory-style valuation of security positions.', href: '/reports/stock_valuation', domain: 'investments', task: 'Reports', kind: 'report', keywords: 'inventory fifo' },
    { id: 'rpt-price-history', title: 'Price History', description: 'Any commodity’s stored quotes charted, with source badges.', href: '/reports/price_history', domain: 'investments', task: 'Reports', kind: 'report', keywords: 'commodity quotes chart scatterplot' },

    // ── Taxes ────────────────────────────────────────────────────────────
    { id: 'tool-tax', title: 'Tax Estimator', description: 'Live federal + state liability from your book, with contribution scenarios.', href: '/tools/tax-estimator', domain: 'taxes', task: 'Plan ahead', kind: 'tool', keywords: 'federal state 1040 quarterly', nav: true },
    { id: 'tool-withholding', title: 'Withholding Checkup', description: 'Projected year-end liability vs withholding, with safe-harbor targets.', href: '/tools/withholding', domain: 'taxes', task: 'Plan ahead', kind: 'tool', keywords: 'w4 paycheck safe harbor', nav: true },
    { id: 'tool-sell-planner', title: 'Sell Planner', description: 'Raise a target amount of cash tax-optimally, with wash-sale screening.', href: '/tools/sell-planner', domain: 'taxes', task: 'Plan ahead', kind: 'tool', keywords: 'tax optimal lots raise cash harvest wash sale', nav: true },
    { id: 'rpt-tax-harvesting', title: 'Tax-Loss Harvesting', description: 'Ranked harvesting opportunities with wash-sale risk flags.', href: '/reports/tax_harvesting', domain: 'taxes', task: 'Plan ahead', kind: 'report', keywords: 'loss tlh' },
    { id: 'rpt-capital-gains', title: 'Capital Gains (Form 8949)', description: 'Realized sales in IRS boxes with Schedule D totals and 1099-B reconciliation.', href: '/reports/capital-gains', domain: 'taxes', task: 'File', kind: 'report', keywords: 'schedule d tax realized 8949', nav: true },
    { id: 'rpt-tax-schedule', title: 'Tax Schedule (TXF Export)', description: 'Tax-related accounts by IRS form, exportable to TurboTax/TaxCut.', href: '/reports/tax_schedule', domain: 'taxes', task: 'File', kind: 'report', keywords: 'txf turbotax export irs forms', nav: true },
    { id: 'rpt-tax-package', title: 'Year-End Tax Package', description: 'One ZIP for your accountant: 8949, Schedule D, contributions, Schedule C, charitable giving.', href: '/reports/tax-package', domain: 'taxes', task: 'File', kind: 'report', keywords: 'accountant zip bundle', nav: true },
    { id: 'rpt-contributions', title: 'Contribution Summary', description: '401(k)/IRA/HSA contributions measured against IRS limits.', href: '/reports/contribution_summary', domain: 'taxes', task: 'File', kind: 'report', keywords: 'ira 401k hsa limits retirement' },
    { id: 'biz-schedule-c', title: 'Schedule C', description: 'Sole-proprietor income and expense lines with a keyword mapper.', href: '/business/reports/schedule-c', domain: 'taxes', task: 'File', kind: 'report', keywords: 'sole proprietor tax', businessOnly: false },
    { id: 'biz-schedule-e', title: 'Schedule E', description: 'Rental property rollups with straight-line depreciation.', href: '/business/reports/schedule-e', domain: 'taxes', task: 'File', kind: 'report', keywords: 'rental property depreciation landlord tax' },

    // ── Planning ─────────────────────────────────────────────────────────
    { id: 'tool-fire', title: 'FIRE Calculator', description: 'Monte Carlo over a century of returns: when can you stop working?', href: '/tools/fire-calculator', domain: 'planning', task: 'Long term', kind: 'tool', keywords: 'retire monte carlo independence', nav: true },
    { id: 'tool-drawdown', title: 'Drawdown & Roth Planner', description: 'Retirement spend-down with RMDs, IRMAA warnings, and bracket-filling conversions.', href: '/tools/drawdown', domain: 'planning', task: 'Long term', kind: 'tool', keywords: 'retirement withdrawal rmd irmaa conversion sequencing', nav: true },
    { id: 'tool-scenario', title: 'Scenario Sandbox', description: 'What if you buy the house? One change threaded through every engine vs baseline.', href: '/tools/scenario', domain: 'planning', task: 'Long term', kind: 'tool', keywords: 'what if buy house loan purchase model compare', nav: true },
    { id: 'tool-forecast', title: 'Cash Flow Forecast', description: '30–180 day balance projections with low-balance warnings.', href: '/tools/cash-flow-forecast', domain: 'planning', task: 'Near term', kind: 'tool', keywords: 'projection 90 days', nav: true },
    { id: 'tool-debt', title: 'Debt Payoff Planner', description: 'Snowball vs avalanche across every liability, with payoff dates.', href: '/tools/debt-payoff', domain: 'planning', task: 'Near term', kind: 'tool', keywords: 'snowball avalanche', nav: true },
    { id: 'tool-subscriptions', title: 'Subscriptions', description: 'Recurring charges detected automatically, with price-increase tracking.', href: '/tools/subscriptions', domain: 'planning', task: 'Near term', kind: 'tool', keywords: 'recurring charges', nav: true },
    { id: 'tool-anomalies', title: 'Spending Watch', description: 'Duplicate charges, first-time merchants, and outliers flagged on every sync.', href: '/tools/anomalies', domain: 'planning', task: 'Near term', kind: 'tool', keywords: 'fraud alerts anomaly duplicate', nav: true },
    { id: 'tool-digest', title: 'Monthly Digest', description: 'The month at a glance — net worth change, cash flow, category deltas.', href: '/tools/digest', domain: 'planning', task: 'Review', kind: 'tool', keywords: 'summary month', nav: true },
    { id: 'rpt-year-in-review', title: 'Year in Review', description: 'The annual wrapped: your money’s whole year on one page.', href: '/reports/year_in_review', domain: 'planning', task: 'Review', kind: 'report', keywords: 'wrapped annual summary highlights' },
    { id: 'rpt-nw-attribution', title: 'Net-Worth Attribution', description: 'Why did net worth change? Savings vs market vs debt paydown, exactly.', href: '/reports/net_worth_attribution', domain: 'planning', task: 'Review', kind: 'report', keywords: 'why change decompose savings market debt waterfall' },
    { id: 'tool-emergency', title: 'In Case of Emergency', description: 'A printable account map with beneficiaries for the people who would need it.', href: '/tools/emergency', domain: 'planning', task: 'Protect', kind: 'tool', keywords: 'beneficiary estate death printable account map', nav: true },
    { id: 'tool-data-health', title: 'Data Health', description: 'Unbalanced transactions, stale prices, and structural checks in one score.', href: '/tools/data-health', domain: 'planning', task: 'Protect', kind: 'tool', keywords: 'integrity check repair score', nav: true },
    { id: 'tool-time-machine', title: 'Time Machine', description: 'Your book as of any date — balances at historical prices, and what changed since.', href: '/tools/time-machine', domain: 'planning', task: 'Review', kind: 'tool', keywords: 'as of historical snapshot past balances compare rewind', nav: true },
    { id: 'tool-mortgage', title: 'Mortgage Calculator', description: 'Payoff timelines with extra payments, from your detected mortgage terms.', href: '/tools/mortgage', domain: 'planning', task: 'Near term', kind: 'tool', keywords: 'amortization loan' },
    { id: 'tool-assets', title: 'Asset Analysis', description: 'Fixed assets with depreciation schedules and valuation history.', href: '/assets', domain: 'planning', task: 'Review', kind: 'tool', keywords: 'fixed depreciation' },
    { id: 'tool-ask', title: 'Ask Your Books', description: 'Plain-English questions answered by read-only queries over your ledger.', href: '/tools/ask', domain: 'home', task: 'Overview', kind: 'tool', keywords: 'ai chat question natural language query', nav: true },

    // ── Reports (financial statements & analytics) ───────────────────────
    { id: 'nav-reports', title: 'All Reports', description: 'The full report catalog — statements, charts, and saved configurations.', href: '/reports', domain: 'reports', task: 'Catalog', kind: 'page', shortcut: 'g r', nav: true },
    { id: 'rpt-balance-sheet', title: 'Balance Sheet', description: 'Assets, liabilities, and equity at a point in time.', href: '/reports/balance_sheet', domain: 'reports', task: 'Statements', kind: 'report', keywords: 'assets liabilities equity' },
    { id: 'rpt-income-statement', title: 'Income Statement', description: 'Profit & loss over any period.', href: '/reports/income_statement', domain: 'reports', task: 'Statements', kind: 'report', keywords: 'profit loss p&l pnl' },
    { id: 'rpt-income-by-period', title: 'Income Statement by Period', description: 'Monthly/quarterly P&L columns side by side.', href: '/reports/income_statement_by_period', domain: 'reports', task: 'Statements', kind: 'report', keywords: 'monthly p&l' },
    { id: 'rpt-cash-flow', title: 'Cash Flow', description: 'Where the money came from and where it went.', href: '/reports/cash_flow', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-equity', title: 'Equity Statement', description: 'Changes in equity over the period.', href: '/reports/equity_statement', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-trial-balance', title: 'Trial Balance', description: 'Every account’s debit/credit balance — the accountant’s sanity check.', href: '/reports/trial_balance', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-general-journal', title: 'General Journal', description: 'All transactions in journal form.', href: '/reports/general_journal', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-general-ledger', title: 'General Ledger Report', description: 'Per-account transaction listings.', href: '/reports/general_ledger', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-account-summary', title: 'Account Summary', description: 'Balances across the account tree at a chosen depth.', href: '/reports/account_summary', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-transaction', title: 'Transaction Report', description: 'Filterable transaction listings for any account set.', href: '/reports/transaction_report', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-net-worth', title: 'Net Worth Chart', description: 'Net worth over time.', href: '/reports/net_worth_chart', domain: 'reports', task: 'Charts', kind: 'report' },
    { id: 'rpt-net-worth-owner', title: 'Net Worth by Owner', description: 'Net worth split by account owner.', href: '/reports/net_worth_by_owner', domain: 'reports', task: 'Charts', kind: 'report' },
    { id: 'rpt-income-expense-chart', title: 'Income & Expense Chart', description: 'Monthly income and expenses over time.', href: '/reports/income_expense_chart', domain: 'reports', task: 'Charts', kind: 'report' },
    { id: 'rpt-account-breakdown', title: 'Account Breakdown', description: 'Pie or bar breakdown of any account type at any depth, with drill-down.', href: '/reports/account_breakdown', domain: 'reports', task: 'Charts', kind: 'report', keywords: 'piechart barchart depth drill spending assets' },
    { id: 'rpt-day-of-week', title: 'Income & Expenses by Day of Week', description: 'Spending patterns by weekday.', href: '/reports/day_of_week', domain: 'reports', task: 'Charts', kind: 'report', keywords: 'weekday spending pattern' },
    { id: 'rpt-average-balance', title: 'Average Balance', description: 'Monthly average/min/max daily balances for cash accounts.', href: '/reports/average_balance', domain: 'reports', task: 'Charts', kind: 'report', keywords: 'daily monthly min max' },
    { id: 'rpt-reconciliation', title: 'Reconciliation Report', description: 'Reconciled vs outstanding by account.', href: '/reports/reconciliation', domain: 'reports', task: 'Statements', kind: 'report' },
    { id: 'rpt-treasurer', title: 'Treasurer Report', description: 'A club/organization treasurer’s period summary.', href: '/reports/treasurer', domain: 'reports', task: 'Statements', kind: 'report' },

    // ── Business ─────────────────────────────────────────────────────────
    { id: 'biz-dashboard', title: 'Business Dashboard', description: 'Revenue, outstanding AR, AP due, and days-to-pay.', href: '/business', domain: 'business', task: 'Overview', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-customers', title: 'Customers', description: 'Customer records with terms and auto-numbering.', href: '/business/customers', domain: 'business', task: 'People', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-vendors', title: 'Vendors', description: 'Vendor records for bills and payments.', href: '/business/vendors', domain: 'business', task: 'People', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-jobs', title: 'Jobs', description: 'Customer/vendor jobs with rates and per-job invoice rollups.', href: '/business/jobs', domain: 'business', task: 'People', kind: 'page', keywords: 'projects rate customer vendor', businessOnly: true, nav: true },
    { id: 'biz-employees', title: 'Employees', description: 'Employee records for expense vouchers.', href: '/business/employees', domain: 'business', task: 'People', kind: 'page', keywords: 'staff workday rate', businessOnly: true, nav: true },
    { id: 'biz-invoices', title: 'Invoices', description: 'GnuCash-compatible invoicing with posting and payments.', href: '/business/invoices', domain: 'business', task: 'Documents', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-bills', title: 'Bills', description: 'Vendor bills with FIFO or explicit payment allocation.', href: '/business/invoices?type=bill', domain: 'business', task: 'Documents', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-vouchers', title: 'Expense Vouchers', description: 'Employee expense reimbursement through the invoice engine.', href: '/business/vouchers', domain: 'business', task: 'Documents', kind: 'page', keywords: 'employee reimbursement expenses', businessOnly: true, nav: true },
    { id: 'biz-payments', title: 'Payments', description: 'The payment center for invoices, bills, and vouchers.', href: '/business/payments', domain: 'business', task: 'Documents', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-recurring', title: 'Recurring Invoices', description: 'Auto-generated invoices on a cadence, duplicate-proof.', href: '/business/recurring', domain: 'business', task: 'Documents', kind: 'page', businessOnly: true, nav: true },
    { id: 'biz-inventory', title: 'Inventory', description: 'SKUs, locations, FIFO/average valuation, BOMs, and COGS postings.', href: '/business/inventory', domain: 'business', task: 'Operations', kind: 'page', keywords: 'stock items sku', businessOnly: true, nav: true },
    { id: 'biz-aging', title: 'AR/AP Aging', description: 'Current/30/60/90+ buckets per customer and vendor.', href: '/business/reports/aging', domain: 'business', task: 'Reports', kind: 'report', keywords: 'receivable payable overdue', businessOnly: true, nav: true },
    { id: 'biz-customer-summary', title: 'Customer Summary', description: 'Sales, expenses, profit, and markup % per customer.', href: '/business/reports/customer-summary', domain: 'business', task: 'Reports', kind: 'report', keywords: 'profitability markup profit per customer', businessOnly: true, nav: true },
    { id: 'biz-sales-tax', title: 'Sales Tax', description: 'Collected tax by period with a filing summary.', href: '/business/reports/sales-tax', domain: 'business', task: 'Reports', kind: 'report', businessOnly: true, nav: true },
    { id: 'rpt-sales-by-customer', title: 'Sales by Customer', description: 'Posted invoice totals per customer.', href: '/reports/sales_by_customer', domain: 'business', task: 'Reports', kind: 'report', businessOnly: true },
    { id: 'rpt-expenses-by-vendor', title: 'Expenses by Vendor', description: 'Spend per vendor with payments and balances.', href: '/reports/expenses_by_vendor', domain: 'business', task: 'Reports', kind: 'report', businessOnly: true },
    { id: 'biz-settings', title: 'Business Settings', description: 'Terms, tax tables, and document numbering.', href: '/business/settings', domain: 'business', task: 'Operations', kind: 'page', keywords: 'terms tax tables numbering', businessOnly: true, nav: true },

    // ── Settings ─────────────────────────────────────────────────────────
    { id: 'nav-settings', title: 'Settings', navTitle: 'General', description: 'Preferences, connections, backups, email, tokens, and security.', href: '/settings', domain: 'settings', task: 'Configuration', kind: 'page', shortcut: 'g s', nav: true },
    { id: 'nav-settings-commodities', title: 'Commodities', description: 'Securities, currencies, and price quote configuration.', href: '/settings/commodities', domain: 'settings', task: 'Configuration', kind: 'page', keywords: 'securities prices quotes', nav: true },
    { id: 'nav-settings-rules', title: 'Categorization Rules', description: 'Auto-categorization for imports, with retroactive application.', href: '/settings/rules', domain: 'settings', task: 'Configuration', kind: 'page', keywords: 'categorization auto', nav: true },
    { id: 'nav-settings-connections', title: 'Connections', description: 'SimpleFIN bank sync connections.', href: '/settings/connections', domain: 'settings', task: 'Configuration', kind: 'page', keywords: 'simplefin bank sync', nav: true },
    { id: 'nav-settings-users', title: 'Users', description: 'Per-book roles: readonly, edit, admin.', href: '/settings/users', domain: 'settings', task: 'Configuration', kind: 'page', keywords: 'permissions roles', nav: true },
    { id: 'nav-settings-history', title: 'Change History', description: 'The audit trail — every mutation, with one-click undo.', href: '/settings/history', domain: 'settings', task: 'Configuration', kind: 'page', keywords: 'audit log undo restore trail', nav: true },
    { id: 'tool-close-book', title: 'Close Book', description: 'Year-end closing entries into equity, previewed and undoable.', href: '/tools/close-book', domain: 'money', task: 'Accounts & ledgers', kind: 'tool', keywords: 'year end closing entries equity retained earnings' },
    { id: 'nav-catalog', title: 'Feature Catalog', description: 'Everything this app can do, searchable, with pinning.', href: '/catalog', domain: 'home', task: 'Overview', kind: 'page', keywords: 'directory all features help discover', nav: true },
    { id: 'nav-doc-search', title: 'Document Search', description: 'One search across receipt OCR text, statement lines, payslips, and transactions.', href: '/search', domain: 'money', task: 'Documents & import', kind: 'page', keywords: 'full text find receipts statements ocr', nav: true },
    { id: 'rpt-fx-revaluation', title: 'FX Revaluation', description: 'Foreign-currency holdings with average acquisition rates and unrealized/realized FX gains.', href: '/reports/fx_revaluation', domain: 'reports', task: 'Statements', kind: 'report', keywords: 'currency exchange foreign gains' },
    { id: 'rpt-bls-comparison', title: 'Spending vs National Averages', description: 'Your categories vs BLS Consumer Expenditure Survey averages for your household size.', href: '/reports/bls_comparison', domain: 'reports', task: 'Charts', kind: 'report', keywords: 'bls benchmark average compare household' },
];

export function featuresByDomain(domain: FeatureDomain, opts?: { businessBook?: boolean }): Feature[] {
    return FEATURES.filter(f =>
        f.domain === domain && (opts?.businessBook !== false || !f.businessOnly),
    );
}

export function featureById(id: string): Feature | undefined {
    return FEATURES.find(f => f.id === id);
}

/** Sidebar model: ordered domains with their nav children. */
export const NAV_DOMAIN_ORDER: FeatureDomain[] = [
    'home', 'money', 'budgets', 'investments', 'taxes', 'planning', 'reports', 'business', 'settings',
];
