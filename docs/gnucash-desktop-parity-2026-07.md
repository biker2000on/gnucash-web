# Feature-Parity Gap Analysis: GnuCash Desktop 5.x vs gnucash-web

*Audited 2026-07-12 against GnuCash 5.x official documentation (Manual §9.3 "Reports
Listed By Class", Guide §10.3 "Standard Reports Overview") and this repo's report
pages, libs, and services. Written before the v0.10.0.0 feature wave landed; items
that wave closed are marked ✅.*

## Coverage snapshot (what gnucash-web already has)

Balance Sheet, Income Statement (+ by-period), Cash Flow, Equity Statement, Trial
Balance, General Journal, General Ledger, Account Summary, Transaction Report,
Treasurer, Net Worth chart (+ by-owner), Income/Expense chart, Investment Portfolio,
Investment Lots, Stock Valuation, Capital Gains (8949), Tax Harvesting, Contribution
Summary (IRS limits), Reconciliation report, Budget Report + budget compare,
Receivable/Payable Aging, Sales Tax, Schedule C, Sales by Customer, Expenses by
Vendor, Customer Statements, saved report configurations, invoices/bills/payments
engine with billterms + taxtables, recurring invoices, inventory, scheduled
transactions (execute/skip/since-last-run/create, mortgage-linked), price editor +
Yahoo fetch + audit, commodities, exchange rates, trading accounts for
multi-currency, stock splits, lot scrub engine, XML import/export, CSV/OFX + AI
statement import with reconciliation, SimpleFin bank sync, multi-book with account
templates, data-health checks, RBAC/OIDC, dashboard, and ~10 analysis tools (FIRE,
forecast, anomalies, subscriptions, debt payoff, digest, tax estimator, withholding).

Since the audit, v0.10.0.0 also added: Schedule E ✅, year-end tax package ✅,
command palette ✅, Ask Your Books ✅, drawdown/Roth planner ✅, equity comp ✅,
audit trail with undo ✅, bulk editing + retroactive rules ✅, quick-add ✅,
scheduled backups ✅, email notifications ✅.

---

## 1. Gaps worth building

| Feature (GnuCash name) | Value | Effort | Rationale |
|---|---|---|---|
| **Tax Schedule Report & TXF Export** | High | M | The one desktop tax feature with no web equivalent; tax mappings and tax-related account flags already exist, so mapping accounts→TXF codes and emitting a .txf file is a natural extension for US users at tax time. |
| **Budget Income Statement / Budget P&L** (budget-vs-actual statement) | High | S | Budget Report + compare exist, but a period-formatted budget-vs-actual P&L with variance columns is the budget report people actually read monthly; the data layer is already there. |
| **Close Book** (Tools → Close Book: closing entries to Equity) | Med | S | Simple transaction generator (zero out Income/Expense into Retained Earnings at year end); keeps the web app usable as the primary book manager without opening desktop. |
| **Asset/Liability/Income/Expense Piecharts & Barcharts** (account breakdown charts with depth/drill-down) | Med | S | The dashboard has fixed charts, but desktop's configurable "breakdown by account at depth N over date range" report family is the most-used casual analytics view; one parameterized chart report page covers all 8 desktop variants. |
| **Customer Summary** (per-customer profitability: income vs expense, markup %) | Med | S | Sales by Customer and Expenses by Vendor exist separately; joining them into profitability-per-customer is cheap and completes the business report set. |
| **Manual reconcile window** (reconcile against an ending balance, no file upload) | Med | M | Statement-import reconciliation covers the main flow, but desktop users often reconcile from a paper/PDF statement balance: enter ending balance, tick splits, R-flag on finish. |
| **Employee expense vouchers + Employee Report** | Med | M | The only business entity family missing (customers/vendors/jobs/billterms/taxtables all exist); needed only if the book has employees — the GnuCash schema tables already exist. |
| **Job Report + Jobs management UI** | Med | S | Jobs are already read for invoice display; adding CRUD + a per-job invoice rollup is incremental. |
| **Average Balance report** | Low | S | Trivial SQL over existing ledger data; useful for interest estimation, nice parity checkbox. |
| **Price Scatterplot / price history chart** | Low | S | Price DB, fetch, and audit exist — a per-commodity price history chart is a small win for validating stored quotes. |
| **Income/Expenses vs Day of Week** | Low | S | Fun spending-pattern analytics fitting the tools section; near-zero backend work. |
| **QIF import** | Low | M | Only matters for migrating legacy non-GnuCash data; XML import covers GnuCash migration and CSV/OFX covers banks. |
| **Budget Balance Sheet / Budget Flow / Budget Barchart** | Low | S–M | Rarely used even on desktop; build only after Budget Income Statement if budget users ask. |

## 2. Gaps not worth building

- **Online banking HBCI / OFX DirectConnect / AqBanking** — superseded by SimpleFin sync + OFX/CSV statement upload; DirectConnect is dying protocol-wise and HBCI is DE-specific.
- **MT940/CAMT importers** — EU bank formats; the AI statement extractor + OFX/CSV path already ingests arbitrary statements.
- **Check printing** — physical-media feature tied to printer calibration and check stock; desktop remains the right tool.
- **Custom Multicolumn Report / Welcome Sample dashboard** — superseded by the composable web dashboard; a drag-and-drop report composer is high effort for something the dashboard already does better.
- **Balance Forecast report** — superseded by the cash-flow-forecast tool (which already includes scheduled transactions).
- **Future Scheduled Transactions Summary** — the scheduled-transactions page already shows upcoming occurrences.
- **Easy/Fancy/Printable/Tax Invoice variants** — the web has one invoice engine with rendering; four Scheme-era layout variants are a desktop artifact.
- **Report stylesheets (Plain/Footer/Head-or-Tail/Technicolor)** — superseded by the design system + CSV export.
- **eguile Balance Sheet, Sample Report, Sample Graphs, Experimental reports** — developer/demo artifacts.
- **Scheme custom reports / Python bindings** — not translatable; the REST API + direct PostgreSQL access is the extensibility story.
- **Register modes (basic / auto-split / transaction journal view)** — desktop register UI concept; the ledger + General Journal report cover the use cases.
- **Stock Transaction Assistant (5.x wizard)** — the investment transaction form + lot scrub engine already handle buys/sells/splits/dividends with more automation (and equity comp now exceeds it ✅).
- **New Account Hierarchy assistant** — covered by default-book creation with a standard hierarchy.
- **DE Steuer/ElStEr export** — country-specific, out of scope for a US-oriented companion.
- **Full Check & Repair (scrub)** — mostly covered by data-health (imbalance/orphan detection) + lot scrub-all; build repair-actions only if data-health surfaces demand.
- **GST/Income & GST Statement** — covered by the Sales Tax business report.
- **Mortgage & Loan Repayment Assistant** — covered better by mortgage detection + mortgage-linked scheduled transactions.

## 3. Web-app advantages (context)

- **Access & collaboration:** PWA on any device, multi-user with RBAC + OIDC SSO, multi-book switching — desktop is single-user, single-machine.
- **Automation:** SimpleFin bank sync, AI receipt/payslip/statement extraction, background jobs, scheduled price refresh, recurring invoices, notification digests, email delivery, nightly backups.
- **Analytics beyond desktop:** tax estimator + withholding planner, FIRE Monte Carlo, drawdown/Roth planner, anomaly detection, subscription detection, debt payoff, rebalancing, benchmarks, dividends, goals, contribution-limit tracking, tax-loss harvesting, Form 8949, Schedule C/E, net worth by owner, Sankey dashboards, Ask Your Books.
- **Modern data plumbing:** cost-basis tracing across transfers, lot auto-assignment with topological scrub-all, statement-driven reconciliation with dedup, price audit, data-health checks, inventory management, change history with undo — several of these exceed desktop's equivalents.

Sources: [GnuCash Manual v5 §9.3 Reports Listed By Class](https://www.gnucash.org/docs/v5/C/gnucash-manual/report-classes.html), [GnuCash Guide v5 §10.3 Standard Reports Overview](https://www.gnucash.org/docs/v5/C/gnucash-guide/rpt_standardrpts.html)
