/**
 * Command palette registry and fuzzy matching.
 *
 * The palette (Ctrl+K) searches four sources: static commands (below),
 * accounts (client-side from useAccounts), and transactions (debounced
 * server search). Static commands cover every navigable page plus
 * global actions dispatched as CustomEvents.
 */

export type PaletteGroup = 'action' | 'navigate' | 'report' | 'tool' | 'business';

export interface PaletteCommand {
    id: string;
    title: string;
    group: PaletteGroup;
    /** Navigate to this route when selected */
    href?: string;
    /** Dispatch this CustomEvent on window when selected */
    event?: string;
    /** Extra terms to match against besides the title */
    keywords?: string;
    /** Displayed keyboard shortcut hint */
    shortcut?: string;
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
    // ── Actions ──────────────────────────────────────────────────────────
    { id: 'act-new-tx', title: 'New Transaction', group: 'action', event: 'open-new-transaction', keywords: 'create add entry', shortcut: 'n' },
    { id: 'act-switch-book', title: 'Switch Book', group: 'action', event: 'open-book-switcher', keywords: 'change book', shortcut: 'g b' },
    { id: 'act-switch-account', title: 'Jump to Account…', group: 'action', event: 'open-account-switcher', keywords: 'quick switcher find', shortcut: 'Ctrl+P' },
    { id: 'act-shortcuts', title: 'Keyboard Shortcuts Help', group: 'action', event: 'open-shortcut-help', keywords: 'keys bindings hotkeys', shortcut: '?' },
    { id: 'act-edit-mode', title: 'Enter Edit Mode', group: 'action', event: 'enter-edit-mode', keywords: 'bulk select', shortcut: 'e' },

    // ── Main navigation ──────────────────────────────────────────────────
    { id: 'nav-dashboard', title: 'Dashboard', group: 'navigate', href: '/dashboard', shortcut: 'g d' },
    { id: 'nav-accounts', title: 'Account Hierarchy', group: 'navigate', href: '/accounts', keywords: 'tree chart of accounts', shortcut: 'g a' },
    { id: 'nav-ledger', title: 'General Ledger', group: 'navigate', href: '/ledger', keywords: 'transactions journal', shortcut: 'g l' },
    { id: 'nav-quick-add', title: 'Quick Add', group: 'navigate', href: '/quick-add', keywords: 'capture expense mobile offline fast entry' },
    { id: 'nav-tags', title: 'Tags', group: 'navigate', href: '/tags', shortcut: 'g t' },
    { id: 'nav-receipts', title: 'Receipts', group: 'navigate', href: '/receipts', keywords: 'uploads' },
    { id: 'nav-payslips', title: 'Payslips', group: 'navigate', href: '/payslips', keywords: 'uploads paycheck payroll' },
    { id: 'nav-statements', title: 'Statements', group: 'navigate', href: '/statements', keywords: 'uploads reconcile bank' },
    { id: 'nav-investments', title: 'Investments — Holdings', group: 'navigate', href: '/investments', keywords: 'portfolio stocks', shortcut: 'g i' },
    { id: 'nav-inv-cash', title: 'Investments — Cash', group: 'navigate', href: '/investments/cash' },
    { id: 'nav-inv-accounts', title: 'Investments — Accounts', group: 'navigate', href: '/investments/accounts' },
    { id: 'nav-inv-rebalancing', title: 'Rebalancing', group: 'navigate', href: '/investments/rebalancing', keywords: 'allocation drift' },
    { id: 'nav-inv-benchmark', title: 'Benchmark', group: 'navigate', href: '/investments/benchmark', keywords: 'sp500 index compare' },
    { id: 'nav-inv-dividends', title: 'Dividends', group: 'navigate', href: '/investments/dividends', keywords: 'income yield calendar' },
    { id: 'nav-inv-equity-comp', title: 'Equity Compensation', group: 'navigate', href: '/investments/equity-comp', keywords: 'rsu espp vest stock options sell to cover' },
    { id: 'nav-inv-fixed-income', title: 'Fixed Income Ladder', group: 'navigate', href: '/investments/fixed-income', keywords: 'bonds cd treasury maturity ytm ladder coupon' },
    { id: 'tool-emergency', title: 'In Case of Emergency', group: 'tool', href: '/tools/emergency', keywords: 'beneficiary estate death printable account map' },
    { id: 'nav-budgets', title: 'Budgets', group: 'navigate', href: '/budgets', shortcut: 'g u' },
    { id: 'nav-goals', title: 'Goals', group: 'navigate', href: '/goals', keywords: 'savings targets', shortcut: 'g o' },
    { id: 'nav-reports', title: 'Reports', group: 'navigate', href: '/reports', shortcut: 'g r' },
    { id: 'nav-import-export', title: 'Import / Export', group: 'navigate', href: '/import-export', keywords: 'xml amazon backup' },
    { id: 'nav-qif-import', title: 'QIF Import', group: 'navigate', href: '/import-export/qif', keywords: 'quicken import bank transfer' },
    { id: 'nav-scheduled', title: 'Scheduled Transactions', group: 'navigate', href: '/scheduled-transactions', keywords: 'recurring sx' },
    { id: 'nav-settings', title: 'Settings', group: 'navigate', href: '/settings', shortcut: 'g s' },
    { id: 'nav-settings-commodities', title: 'Settings — Commodities', group: 'navigate', href: '/settings/commodities', keywords: 'securities prices quotes' },
    { id: 'nav-settings-rules', title: 'Settings — Rules', group: 'navigate', href: '/settings/rules', keywords: 'categorization auto' },
    { id: 'nav-settings-connections', title: 'Settings — Connections', group: 'navigate', href: '/settings/connections', keywords: 'simplefin bank sync' },
    { id: 'nav-settings-users', title: 'Settings — Users', group: 'navigate', href: '/settings/users', keywords: 'permissions roles' },
    { id: 'nav-settings-history', title: 'Settings — Change History', group: 'navigate', href: '/settings/history', keywords: 'audit log undo restore trail' },

    // ── Reports ──────────────────────────────────────────────────────────
    { id: 'rpt-balance-sheet', title: 'Balance Sheet', group: 'report', href: '/reports/balance_sheet', keywords: 'assets liabilities equity' },
    { id: 'rpt-income-statement', title: 'Income Statement', group: 'report', href: '/reports/income_statement', keywords: 'profit loss p&l pnl' },
    { id: 'rpt-income-by-period', title: 'Income Statement by Period', group: 'report', href: '/reports/income_statement_by_period', keywords: 'monthly p&l' },
    { id: 'rpt-cash-flow', title: 'Cash Flow', group: 'report', href: '/reports/cash_flow' },
    { id: 'rpt-net-worth', title: 'Net Worth Chart', group: 'report', href: '/reports/net_worth_chart' },
    { id: 'rpt-nw-attribution', title: 'Net-Worth Attribution', group: 'report', href: '/reports/net_worth_attribution', keywords: 'why change decompose savings market debt waterfall' },
    { id: 'rpt-year-in-review', title: 'Year in Review', group: 'report', href: '/reports/year_in_review', keywords: 'wrapped annual summary highlights' },
    { id: 'rpt-net-worth-owner', title: 'Net Worth by Owner', group: 'report', href: '/reports/net_worth_by_owner' },
    { id: 'rpt-equity', title: 'Equity Statement', group: 'report', href: '/reports/equity_statement' },
    { id: 'rpt-trial-balance', title: 'Trial Balance', group: 'report', href: '/reports/trial_balance' },
    { id: 'rpt-general-journal', title: 'General Journal', group: 'report', href: '/reports/general_journal' },
    { id: 'rpt-general-ledger', title: 'General Ledger Report', group: 'report', href: '/reports/general_ledger' },
    { id: 'rpt-account-summary', title: 'Account Summary', group: 'report', href: '/reports/account_summary' },
    { id: 'rpt-transaction', title: 'Transaction Report', group: 'report', href: '/reports/transaction_report' },
    { id: 'rpt-income-expense-chart', title: 'Income & Expense Chart', group: 'report', href: '/reports/income_expense_chart' },
    { id: 'rpt-account-breakdown', title: 'Account Breakdown', group: 'report', href: '/reports/account_breakdown', keywords: 'piechart barchart depth drill spending assets' },
    { id: 'rpt-price-history', title: 'Price History', group: 'report', href: '/reports/price_history', keywords: 'commodity quotes chart scatterplot' },
    { id: 'rpt-day-of-week', title: 'Income & Expenses by Day of Week', group: 'report', href: '/reports/day_of_week', keywords: 'weekday spending pattern' },
    { id: 'rpt-average-balance', title: 'Average Balance', group: 'report', href: '/reports/average_balance', keywords: 'daily monthly min max' },
    { id: 'rpt-portfolio', title: 'Investment Portfolio', group: 'report', href: '/reports/investment_portfolio' },
    { id: 'rpt-lots', title: 'Investment Lots', group: 'report', href: '/reports/investment_lots', keywords: 'cost basis gains' },
    { id: 'rpt-stock-valuation', title: 'Stock Valuation', group: 'report', href: '/reports/stock_valuation', keywords: 'inventory fifo' },
    { id: 'rpt-capital-gains', title: 'Capital Gains (Form 8949)', group: 'report', href: '/reports/capital-gains', keywords: 'schedule d tax realized' },
    { id: 'rpt-tax-harvesting', title: 'Tax Harvesting', group: 'report', href: '/reports/tax_harvesting', keywords: 'loss tlh' },
    { id: 'rpt-tax-schedule', title: 'Tax Schedule Report (TXF Export)', group: 'report', href: '/reports/tax_schedule', keywords: 'txf turbotax export irs forms' },
    { id: 'rpt-contributions', title: 'Contribution Summary', group: 'report', href: '/reports/contribution_summary', keywords: 'ira 401k hsa limits retirement' },
    { id: 'rpt-budget', title: 'Budget Report', group: 'report', href: '/reports/budget_report', keywords: 'budgeted actual variance' },
    { id: 'rpt-budget-income', title: 'Budget Income Statement', group: 'report', href: '/reports/budget_income_statement', keywords: 'budget pnl variance favorable' },
    { id: 'rpt-budget-bs', title: 'Budget Balance Sheet', group: 'report', href: '/reports/budget_balance_sheet', keywords: 'projected balances budget' },
    { id: 'rpt-reconciliation', title: 'Reconciliation Report', group: 'report', href: '/reports/reconciliation' },
    { id: 'rpt-treasurer', title: 'Treasurer Report', group: 'report', href: '/reports/treasurer' },
    { id: 'rpt-sales-by-customer', title: 'Sales by Customer', group: 'report', href: '/reports/sales_by_customer' },
    { id: 'rpt-expenses-by-vendor', title: 'Expenses by Vendor', group: 'report', href: '/reports/expenses_by_vendor' },

    // ── Tools ────────────────────────────────────────────────────────────
    { id: 'tool-hub', title: 'All Tools', group: 'tool', href: '/tools', shortcut: 'g w' },
    { id: 'tool-ask', title: 'Ask Your Books', group: 'tool', href: '/tools/ask', keywords: 'ai chat question natural language query' },
    { id: 'tool-forecast', title: 'Cash Flow Forecast', group: 'tool', href: '/tools/cash-flow-forecast', keywords: 'projection 90 days' },
    { id: 'tool-subscriptions', title: 'Subscriptions', group: 'tool', href: '/tools/subscriptions', keywords: 'recurring charges' },
    { id: 'tool-anomalies', title: 'Spending Watch', group: 'tool', href: '/tools/anomalies', keywords: 'fraud alerts anomaly duplicate' },
    { id: 'tool-debt', title: 'Debt Payoff Planner', group: 'tool', href: '/tools/debt-payoff', keywords: 'snowball avalanche' },
    { id: 'tool-digest', title: 'Monthly Digest', group: 'tool', href: '/tools/digest', keywords: 'summary month' },
    { id: 'tool-fire', title: 'FIRE Calculator', group: 'tool', href: '/tools/fire-calculator', keywords: 'retire monte carlo independence' },
    { id: 'tool-drawdown', title: 'Drawdown & Roth Planner', group: 'tool', href: '/tools/drawdown', keywords: 'retirement withdrawal rmd irmaa conversion sequencing' },
    { id: 'tool-sell-planner', title: 'Sell Planner', group: 'tool', href: '/tools/sell-planner', keywords: 'tax optimal lots raise cash harvest wash sale' },
    { id: 'tool-scenario', title: 'Scenario Sandbox', group: 'tool', href: '/tools/scenario', keywords: 'what if buy house loan purchase model compare' },
    { id: 'tool-tax', title: 'Tax Estimator', group: 'tool', href: '/tools/tax-estimator', keywords: 'federal state 1040 quarterly' },
    { id: 'tool-withholding', title: 'Withholding Checkup', group: 'tool', href: '/tools/withholding', keywords: 'w4 paycheck safe harbor' },
    { id: 'tool-mortgage', title: 'Mortgage Calculator', group: 'tool', href: '/tools/mortgage', keywords: 'amortization loan' },
    { id: 'tool-data-health', title: 'Data Health', group: 'tool', href: '/tools/data-health', keywords: 'integrity check repair score' },
    { id: 'tool-assets', title: 'Asset Analysis', group: 'tool', href: '/assets', keywords: 'fixed depreciation' },

    // ── Business ─────────────────────────────────────────────────────────
    { id: 'biz-dashboard', title: 'Business Dashboard', group: 'business', href: '/business' },
    { id: 'biz-customers', title: 'Customers', group: 'business', href: '/business/customers' },
    { id: 'biz-vendors', title: 'Vendors', group: 'business', href: '/business/vendors' },
    { id: 'biz-invoices', title: 'Invoices', group: 'business', href: '/business/invoices' },
    { id: 'biz-bills', title: 'Bills', group: 'business', href: '/business/invoices?type=bill' },
    { id: 'biz-payments', title: 'Payments', group: 'business', href: '/business/payments' },
    { id: 'biz-jobs', title: 'Jobs', group: 'business', href: '/business/jobs', keywords: 'projects rate customer vendor' },
    { id: 'biz-employees', title: 'Employees', group: 'business', href: '/business/employees', keywords: 'staff workday rate' },
    { id: 'biz-vouchers', title: 'Expense Vouchers', group: 'business', href: '/business/vouchers', keywords: 'employee reimbursement expenses' },
    { id: 'biz-customer-summary', title: 'Customer Summary', group: 'business', href: '/business/reports/customer-summary', keywords: 'profitability markup profit per customer' },
    { id: 'biz-recurring', title: 'Recurring Invoices', group: 'business', href: '/business/recurring' },
    { id: 'biz-inventory', title: 'Inventory', group: 'business', href: '/business/inventory', keywords: 'stock items sku' },
    { id: 'biz-aging', title: 'AR/AP Aging', group: 'business', href: '/business/reports/aging', keywords: 'receivable payable overdue' },
    { id: 'biz-sales-tax', title: 'Sales Tax Report', group: 'business', href: '/business/reports/sales-tax' },
    { id: 'biz-schedule-c', title: 'Schedule C', group: 'business', href: '/business/reports/schedule-c', keywords: 'sole proprietor tax' },
    { id: 'biz-schedule-e', title: 'Schedule E', group: 'business', href: '/business/reports/schedule-e', keywords: 'rental property depreciation landlord tax' },
    { id: 'biz-settings', title: 'Business Settings', group: 'business', href: '/business/settings', keywords: 'terms tax tables numbering' },
];

/**
 * Fuzzy score: higher is better, -1 means no match.
 *
 * Tiers: exact title (1000) > title prefix (600) > word prefix (400) >
 * substring (250) > keyword substring (150) > subsequence (10 + density).
 */
export function fuzzyScore(query: string, title: string, keywords = ''): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const t = title.toLowerCase();

    if (t === q) return 1000;
    if (t.startsWith(q)) return 600;

    // Word-prefix: any word in the title starts with the query
    const words = t.split(/[\s—:/&()-]+/);
    if (words.some(w => w.startsWith(q))) return 400;

    const idx = t.indexOf(q);
    if (idx >= 0) return 250 - Math.min(idx, 100);

    if (keywords && keywords.toLowerCase().includes(q)) return 150;

    // Subsequence match over the title (e.g. "cgf" → "Cash flow ForeCast")
    let ti = 0;
    let matched = 0;
    for (const ch of q) {
        const found = t.indexOf(ch, ti);
        if (found === -1) return -1;
        matched += 1;
        ti = found + 1;
    }
    if (matched !== q.length) return -1;
    // Denser matches (shorter span) score slightly higher
    return 10 + Math.max(0, 50 - ti);
}

export interface ScoredCommand extends PaletteCommand {
    score: number;
}

/** Filter + rank the static registry for a query. */
export function searchCommands(query: string, commands: PaletteCommand[] = PALETTE_COMMANDS): ScoredCommand[] {
    const q = query.trim();
    if (!q) {
        // Empty query: actions first, then primary navigation
        return commands
            .filter(c => c.group === 'action' || c.group === 'navigate')
            .map(c => ({ ...c, score: c.group === 'action' ? 2 : 1 }));
    }
    return commands
        .map(c => ({ ...c, score: fuzzyScore(q, c.title, c.keywords) }))
        .filter(c => c.score >= 0)
        .sort((a, b) => b.score - a.score);
}
