/**
 * Content model for the logged-out marketing pages ("/" and /features/*).
 * Pure data — rendered by src/app/(marketing)/.
 */

export interface FeatureItem {
    name: string;
    description: string;
}

export interface FeatureSection {
    heading: string;
    lead: string;
    items: FeatureItem[];
}

export interface FeaturePage {
    slug: string;
    navLabel: string;
    title: string;
    tagline: string;
    heroImage: string;
    heroAlt: string;
    sections: FeatureSection[];
}

export const FEATURE_PAGES: FeaturePage[] = [
    {
        slug: 'accounting',
        navLabel: 'Accounting',
        title: 'Real double-entry accounting, everywhere you are',
        tagline:
            'Your GnuCash book — the same accounts, splits, and lots — served as a fast web app. Nothing is reinterpreted, nothing is locked in.',
        heroImage: '/marketing/accounting.jpg',
        heroAlt: 'Tax forms and a calculator on a desk',
        sections: [
            {
                heading: 'The ledger, done right',
                lead: 'Every view respects double-entry semantics: balanced splits, running balances, and GnuCash sign conventions.',
                items: [
                    { name: 'Account hierarchy', description: 'The full tree with balances, dual-column investment views, hide/show, sorting, and persistent state.' },
                    { name: 'Account & general ledgers', description: 'Running balances, infinite scroll, debounced search with #tag syntax, and a right-click context menu.' },
                    { name: 'Bulk editing', description: 'Multi-select to review, move, delete, recategorize, retag, or find-and-replace descriptions across hundreds of transactions.' },
                    { name: 'Change history with undo', description: 'Every mutation is recorded with full before/after snapshots. Restore a deleted transaction with one click.' },
                    { name: 'Quick Add', description: 'A thumb-first capture screen with an offline queue — record the coffee while you are still in line, sync later.' },
                    { name: 'Scheduled transactions', description: 'All nine GnuCash recurrence types with execute/skip, batch catch-up, and mortgage-aware dynamic amounts.' },
                ],
            },
            {
                heading: 'Statements, receipts, and reconciliation',
                lead: 'Close the loop between your bank and your book.',
                items: [
                    { name: 'Statement import & reconcile', description: 'Upload PDF, CSV, or OFX statements; auto-match lines to the ledger and tie out to the closing balance before finalizing.' },
                    { name: 'Receipt management', description: 'Drag-and-drop or camera capture, OCR extraction, auto-matching to transactions, and a searchable gallery.' },
                    { name: 'Payslip import', description: 'PDF paystubs extracted into full split transactions — taxes, deductions, and retirement contributions itemized.' },
                    { name: 'Multiple books', description: 'Household, business, or organization books in one database with per-book roles and permissions.' },
                    { name: 'Scheduled backups', description: 'Every book exported on your schedule to desktop-compatible GnuCash XML with retention, download, and restore.' },
                ],
            },
            {
                heading: 'Close the books with confidence',
                lead: 'The rigor of desktop accounting, without leaving the browser.',
                items: [
                    { name: 'Manual reconcile', description: 'Tick splits against a paper statement’s ending balance — exact to the cent, verified server-side.' },
                    { name: 'Close Book', description: 'Year-end closing entries into equity, previewed first and undoable afterward.' },
                    { name: 'QIF import', description: 'Bring decades of Quicken history over with transfer matching and duplicate detection.' },
                    { name: 'Document search', description: 'One search across receipt OCR text, statement lines, payslips, and transactions.' },
                    { name: 'Time machine', description: 'See the whole book exactly as it stood on any past date — and what changed since.' },
                    { name: 'Email-in ingestion', description: 'Forward a receipt or statement to your private mailbox; it lands in the book, extracted.' },
                ],
            },
        ],
    },
    {
        slug: 'investments',
        navLabel: 'Investments',
        title: 'Institutional-grade investment tracking',
        tagline:
            'Lot-level cost basis, realized gains that match the IRS forms, and portfolio analytics that answer real questions.',
        heroImage: '/marketing/investments.jpg',
        heroAlt: 'A trading terminal showing a candlestick chart',
        sections: [
            {
                heading: 'Cost basis you can defend',
                lead: 'The lot engine mirrors GnuCash desktop: sells split across lots, transfers keep their acquisition dates, and gains post as balanced transactions.',
                items: [
                    { name: 'Lot tracking & scrubbing', description: 'FIFO, LIFO, or average-cost auto-assignment with transfer-aware topological ordering and full revert.' },
                    { name: 'Capital gains — Form 8949', description: 'Realized sales bucketed into IRS boxes with Schedule D totals, wash-sale adjustments, and 1099-B reconciliation.' },
                    { name: 'Equity compensation', description: 'RSU vests and ESPP purchases post with FMV basis and the discount as income — the double-taxation trap avoided by construction.' },
                    { name: 'Tax-loss harvesting', description: 'Ranked opportunities with wash-sale risk flags before you trade.' },
                    { name: 'Cryptocurrency', description: 'First-class crypto commodities with daily quotes and sub-cent price precision.' },
                    { name: 'Contribution tracking', description: '401(k), IRA, and HSA contributions classified automatically and measured against IRS limits with catch-up rules.' },
                ],
            },
            {
                heading: 'Performance, honestly measured',
                lead: 'Time-weighted returns that survive rebalances, provider switches, and closed positions.',
                items: [
                    { name: 'Portfolio & holdings', description: 'Market value, cost basis, unrealized gains, and sector exposure across every account.' },
                    { name: 'Benchmark comparison', description: 'Your TWR vs S&P 500, Dow, NASDAQ, and Russell 2000 over 1Y/3Y/5Y/YTD/max.' },
                    { name: 'Dividend intelligence', description: 'Trailing-twelve-month income, yield on cost, a monthly income chart, and a forward payment calendar.' },
                    { name: 'Rebalancing', description: 'Per-symbol or per-sector targets with drift bands, buy-only mode for new money, and tax-aware sell ordering.' },
                    { name: 'Price service', description: 'Daily Yahoo Finance quotes for stocks, funds, indices, and crypto — no API key required.' },
                    { name: 'Data health', description: 'Continuous checks for unbalanced transactions, stale prices, and structural corruption, rolled into a 0–100 score.' },
                ],
            },
            {
                heading: 'Decide what to sell — and when',
                lead: 'The tax engine and the lot engine, working together.',
                items: [
                    { name: 'Sell Planner', description: '“Raise $25,000” — the exact lots that do it with minimum tax, wash sales screened, savings shown vs naive FIFO.' },
                    { name: 'Fixed-income ladder', description: 'Bonds, CDs, and Treasuries with solved YTM, a maturity ladder, and a reinvestment calendar.' },
                    { name: 'Price alerts', description: 'Get notified the day a holding crosses your target — checked right after each daily quote refresh.' },
                    { name: 'Net-worth attribution', description: 'Savings vs market gains vs debt paydown — why your net worth moved, summing exactly to the change.' },
                    { name: 'Account performance', description: 'Time-weighted returns per account that survive rebalances and provider switches.' },
                    { name: 'FX revaluation', description: 'Foreign-currency holdings with average acquisition rates and unrealized gains.' },
                ],
            },
        ],
    },
    {
        slug: 'planning',
        navLabel: 'Planning & Tax',
        title: 'Plan decades ahead with your real numbers',
        tagline:
            'Not a calculator with made-up inputs — every projection starts from the book you already keep.',
        heroImage: '/marketing/planning.jpg',
        heroAlt: 'Two people planning with notebooks and laptops',
        sections: [
            {
                heading: 'Retirement, modeled properly',
                lead: 'Monte Carlo where it matters, tax law where it counts.',
                items: [
                    { name: 'FIRE calculator', description: 'Bootstrap simulation over the 1928–2024 return history with confidence bands, glide paths, and withdrawal strategies.' },
                    { name: 'Drawdown & Roth planner', description: 'Year-by-year spend-down with withdrawal sequencing, SECURE 2.0 RMDs, IRMAA warnings, and bracket-filling Roth conversions.' },
                    { name: 'Social Security estimation', description: 'Your benefit computed from the earnings history already in your book, for any claiming age.' },
                    { name: 'Financial goals', description: 'Emergency fund, savings, and debt-payoff goals with completion dates projected through the forecast engine.' },
                    { name: 'Cash flow forecast', description: '30–180 day projections from scheduled transactions plus your actual daily run rate, with low-balance alerts.' },
                    { name: 'Debt payoff planner', description: 'Snowball vs avalanche across every liability with freed-minimum rollover and payoff dates.' },
                ],
            },
            {
                heading: 'Taxes, before they surprise you',
                lead: 'Federal and state estimation that reads your actual income as it happens.',
                items: [
                    { name: 'Tax estimator', description: 'Federal brackets, LTCG stacking, NIIT, SE tax, and pluggable state modules — computed live from book data.' },
                    { name: 'Withholding checkup', description: 'Projected year-end liability vs withholding with safe-harbor targets and per-paycheck adjustments.' },
                    { name: 'Year-end tax package', description: 'One ZIP for your accountant: Form 8949, Schedule D, contributions, Schedule C, and charitable giving.' },
                    { name: 'Budgets with envelopes', description: 'Rollover budgeting, overspend alerts, pace markers, auto-budget from history, and scenario comparison.' },
                    { name: 'Monthly digest', description: 'Net-worth change, cash flow, category deltas, subscription changes, and upcoming bills — in app or by email.' },
                    { name: 'Contribution scenarios', description: 'Model a bigger 401(k) deferral or an IRA top-up and see the tax delta instantly.' },
                ],
            },
            {
                heading: 'Big decisions, tested first',
                lead: 'Model the move before you make it.',
                items: [
                    { name: 'Scenario Sandbox', description: '“What if we buy the house?” One change threaded through cash flow, net worth, taxes, and your FIRE date — side by side with baseline.' },
                    { name: 'Year in Review', description: 'The annual wrapped: your money’s whole year on one printable page.' },
                    { name: 'TXF tax export', description: 'Tax-related accounts grouped by IRS form and exported straight into TurboTax or TaxCut.' },
                    { name: 'Budget Income Statement', description: 'The monthly read: budget vs actual with favorable/unfavorable variances.' },
                    { name: 'In Case of Emergency', description: 'A printable map of every account, institution, and beneficiary for the people who would need it.' },
                    { name: 'Spending vs national averages', description: 'Your categories against BLS Consumer Expenditure figures for your household size.' },
                ],
            },
        ],
    },
    {
        slug: 'business',
        navLabel: 'Business',
        title: 'Run a small business on your own books',
        tagline:
            'GnuCash-compatible invoicing, receivables, and inventory — with the reports a sole proprietor actually files.',
        heroImage: '/marketing/business.jpg',
        heroAlt: 'A customer paying at a small business point of sale',
        sections: [
            {
                heading: 'From invoice to payment',
                lead: 'The native GnuCash business engine, modernized.',
                items: [
                    { name: 'Invoices & bills', description: 'Desktop-compatible posting with discounts, tax tables, unposting, and FIFO or explicit payment allocation.' },
                    { name: 'Customers, vendors & jobs', description: 'Full CRUD with auto-numbering, billing terms, and deactivate-not-delete safety.' },
                    { name: 'Recurring invoices', description: 'Define from any document, month-end anchoring, optional auto-post, duplicate-proof generation.' },
                    { name: 'Customer statements', description: 'Printable per-customer statements with running balances and an aging footer.' },
                    { name: 'Inventory', description: 'SKUs, locations, moving-average or FIFO valuation, BOM assembly, reorder alerts, and COGS postings.' },
                    { name: 'AR/AP aging', description: 'Current/30/60/90+ buckets per owner, plus a business dashboard with days-to-pay.' },
                ],
            },
            {
                heading: 'Reports the IRS recognizes',
                lead: 'Straight from your ledger to the form.',
                items: [
                    { name: 'Schedule C', description: 'Sole-proprietor income and expense lines with a keyword mapper and manual overrides.' },
                    { name: 'Schedule E', description: 'Per-property rental rollups with straight-line depreciation and the mid-month convention.' },
                    { name: 'Sales tax', description: 'Collected tax by period with a monthly filing summary.' },
                    { name: 'Sales & spend analysis', description: 'Sales by customer and expenses by vendor, with payments and balances.' },
                    { name: 'Entity-aware navigation', description: 'Business features appear only on business books; your household book stays clean.' },
                    { name: 'Household inventory option', description: 'Track home stock and supplies with reorder points on personal books too.' },
                ],
            },
            {
                heading: 'Know your customers and your crew',
                lead: 'The rest of the desktop business suite, modernized.',
                items: [
                    { name: 'Customer Summary', description: 'Sales, attributable expenses, profit, and markup % per customer.' },
                    { name: 'Jobs', description: 'Customer and vendor jobs with rates and per-job invoice rollups.' },
                    { name: 'Employee expense vouchers', description: 'Reimbursements posted through the native invoice engine, paid through the standard payment path.' },
                    { name: 'Accountant share links', description: 'Time-boxed read-only report links — your accountant sees the statements, never your login.' },
                    { name: 'Scheduled report delivery', description: 'The month-end pack emailed automatically, HTML plus CSV.' },
                    { name: 'Print-ready everything', description: 'Global print stylesheets turn any report into a clean PDF via your browser.' },
                ],
            },
        ],
    },
    {
        slug: 'automation',
        navLabel: 'Automation & AI',
        title: 'The bookkeeping does itself',
        tagline:
            'Bank sync, AI document extraction, and a watchful background worker — self-hosted, on your hardware, under your keys.',
        heroImage: '/marketing/automation.jpg',
        heroAlt: 'Server racks with network cables and status lights',
        sections: [
            {
                heading: 'Data flows in on its own',
                lead: 'Connect once; the worker handles the rest on schedule.',
                items: [
                    { name: 'Bank sync (SimpleFIN)', description: 'Transactions import with reconciliation matching, transfer dedup, and bank-verified badges.' },
                    { name: 'AI document extraction', description: 'Receipts, payslips, and PDF statements parsed by the AI provider you configure — OpenAI, Anthropic, or local Ollama.' },
                    { name: 'Auto-categorization rules', description: 'Contains/exact/regex rules with learned suggestions, applied at import and retroactively with a dry-run preview.' },
                    { name: 'Scheduled prices & backups', description: 'Daily quotes and nightly desktop-compatible XML backups with retention.' },
                    { name: 'Ask Your Books', description: 'Plain-English questions answered by guard-railed, read-only SQL over your book, with drill-down links.' },
                    { name: 'Email delivery', description: 'Digest and alerts to your inbox via your own SMTP, with per-type opt-in.' },
                ],
            },
            {
                heading: 'A worker that watches your money',
                lead: 'Alerts arrive before problems become expensive.',
                items: [
                    { name: 'Spending watch', description: 'Duplicate charges, first-time merchants, amount outliers, and category spikes flagged on every sync.' },
                    { name: 'Subscription detection', description: 'Recurring charges found automatically, with price-increase tracking and annualized totals.' },
                    { name: 'Budget & balance alerts', description: 'Overspend thresholds, projected overruns, and low-balance warnings from the forecast.' },
                    { name: 'Self-hosted & private', description: 'One Docker image, your PostgreSQL, your S3 or filesystem. No third party ever sees your ledger.' },
                    { name: 'OIDC single sign-on', description: 'Pocket ID, Keycloak, Auth0, or any OIDC provider, with per-book readonly/edit/admin roles.' },
                    { name: 'PWA everywhere', description: 'Installable on phone and desktop with offline capture and keyboard-driven power use (Ctrl+K).' },
                ],
            },
            {
                heading: 'Open to everything you run',
                lead: 'A self-hoster’s integration surface.',
                items: [
                    { name: 'API tokens', description: 'Scoped personal access tokens for scripts, Grafana, or Home Assistant — hashed at rest, role-capped live.' },
                    { name: 'Outbound webhooks', description: 'HMAC-signed deliveries on every alert, ready for anything that speaks HTTP.' },
                    { name: 'iCal feeds', description: 'Subscribe your calendar to upcoming bills, bond maturities, and RMD deadlines.' },
                    { name: 'Natural-language entry', description: 'Type “$40 gas yesterday” and confirm the prefilled transaction.' },
                    { name: 'Daily insights', description: 'Category spikes, first-time merchants, and milestone crossings surface on the dashboard by themselves.' },
                    { name: 'Opt-in two-factor auth', description: 'RFC 6238 TOTP with recovery codes — entirely optional, never forced.' },
                ],
            },
        ],
    },
];

/** Landing-page pillar cards (one per feature page). */
export const PILLARS = FEATURE_PAGES.map(p => ({
    slug: p.slug,
    label: p.navLabel,
    title: p.title,
    tagline: p.tagline,
    image: p.heroImage,
    alt: p.heroAlt,
}));

export const LANDING_STATS = [
    { value: '35+', label: 'report types' },
    { value: '20+', label: 'planning & analysis tools' },
    { value: '100%', label: 'GnuCash-compatible schema' },
    { value: '0', label: 'third parties holding your data' },
];
