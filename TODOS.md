# Product Roadmap and TODOs

Updated 2026-07-23.

GnuCash Web has passed the point where desktop parity or raw feature count is the
right roadmap. The product already has accounting-grade books, household and
business workflows, tax and planning engines, document evidence, automation,
audit history, and undo.

The next version of the product should become an **explainable, self-hosted
financial operating system**:

1. Tell the user what needs attention.
2. Rank the highest-value decisions.
3. Show what will happen before anything changes.
4. Carry out approved work safely.
5. Prove every number afterward.

## Product rules

Every new feature should satisfy these rules:

- **No orphan tools.** New capabilities must feed at least one shared surface:
  Action Center, Money Timeline, Living Plan, or Financial Provenance.
- **Deterministic before generative.** Financial calculations, ranking, and
  mutations use typed domain logic. AI may explain, normalize, or suggest, but
  it does not invent figures or write unrestricted SQL.
- **Preview, approve, undo.** Material changes show their balanced transaction
  or configuration diff before execution and produce an audit record afterward.
- **Evidence is part of the result.** Recommendations identify their source
  transactions, documents, prices, FX rates, rules, assumptions, and confidence.
- **Book-aware by default.** New services must declare whether they operate on
  one book, linked books, or a consolidated household/entity graph.
- **Close loops.** Prefer features that move from observation to decision to
  action to reconciliation instead of producing another passive report.

## Priority definitions

| Priority | Meaning |
|---|---|
| **P0** | Product foundation; build before expanding the feature catalog |
| **P1** | Next major workflow or correctness requirement |
| **P2** | Valuable feature pack that should use the shared foundations |
| **P3** | Targeted expansion or connector |
| **P4** | Nice-to-have, cleanup, or low-frequency operation |

## North-star measures

- Minutes per week required to reach a trusted, reviewed financial position
- Percentage of Action Center items resolved, automated, or converted into rules
- Annual dollar impact surfaced and accepted through the Opportunity Engine
- Percentage of material report figures with complete provenance
- Reconciled-account coverage and latest verified-through date
- Difference between the adopted plan and actual results, with causes explained

## Recommended delivery sequence

1. [Done] Define the shared `FinancialAction`, `EvidenceRef`, and
   `CalculationTrace` contracts.
2. [Done] Ship the Action Center using existing review, receipt, statement,
   health, compliance, close, job, and notification sources.
3. [Done] Add Universal Financial Provenance to the highest-value KPIs,
   reports, balances, forecasts, and existing deterministic insights.
4. [Done] Add the first eight Opportunity Engine packs and rank them in the
   Action Center.
5. Normalize existing dated obligations into the Money Timeline.
6. Let a scenario become an adopted Living Plan and reconcile it to actuals.
7. Extend book links into cross-book consolidation.
8. Add the Safe Operator Agent only after previewable domain commands are
   available.

Feature packs may ship alongside this sequence when they use the shared
contracts. They should not introduce a new private inbox, recommendation feed,
calendar model, scenario engine, or evidence format.

---

# Platform roadmap

## P0 - Financial Action Center

**Status:** Implemented 2026-07-23.

**Outcome:** One trusted place answers, “What needs my attention?” The target
workflow is a five-minute weekly financial close, not a tour through many pages.

**What:** Create a shared `FinancialAction` model and an Action Center with three
lanes:

- **Fix:** unreviewed imports, uncertain categories, unmatched receipts,
  statement discrepancies, unbalanced transactions, stale prices, failed jobs,
  and missing source documents.
- **Decide:** tax shortfalls, contribution opportunities, budget tradeoffs,
  expiring policies, replacement needs, large anomalies, and plan deviations.
- **Do:** approved payments, scheduled transactions, reimbursements, close
  tasks, document requests, and other pending operations.

Each action carries book scope, origin, severity, due date, estimated dollar
impact, confidence, evidence references, available operations, assignee, and a
state of open, snoozed, accepted, resolved, dismissed, or expired.

**MVP:**

1. Adapters for transaction review, receipt inbox, statement reconciliation,
   Data Health, proactive insights, compliance deadlines, business close,
   failed jobs, and notifications.
2. Keyboard-first desktop triage and swipe-friendly mobile review.
3. Batch accept/dismiss/snooze, “create a rule,” and direct links to the exact
   resolution surface.
4. A meaningful empty state: “Books reviewed through July 23.”
5. Weekly summary showing new, resolved, automated, and overdue actions.

**Depends on:** Existing review metadata, notifications, insights, audit log,
job progress, receipts, statements, Data Health, and compliance services.

**Effort:** L.

**Delivered:** Shared typed action/state contracts, nine source adapters,
Fix/Decide/Do lanes, keyboard and mobile triage, bulk state operations, direct
resolution links, weekly close metrics, verified-through empty state, and
durable outcome tracking.

---

## P0 - Opportunity Engine / “Next Best Dollar”

**Status:** Implemented 2026-07-23.

**Outcome:** Answer, “What is the most valuable safe thing I can do with the next
$1,000, hour, or decision?”

**What:** Add deterministic opportunity packs that emit `FinancialAction`
records. Rank them by estimated after-tax value, urgency, confidence, liquidity
cost, reversibility, and user goals. AI can rewrite the explanation, but the
calculation and ranking remain inspectable domain logic.

**Initial opportunity packs:**

1. Estimated-tax and safe-harbor shortfalls
2. Unused employer match and tax-advantaged contribution capacity
3. High-interest debt versus excess cash
4. Emergency-fund and near-term cash-flow shortfalls
5. Portfolio drift, idle investment cash, and maturing fixed income
6. Tax-loss harvesting, gain realization, and Roth-conversion windows
7. Subscription price increases, duplicates, and avoidable recurring costs
8. Budget funding gaps for known future obligations
9. Insurance, healthcare, home, and vehicle gaps as those feature packs land

Every opportunity should show:

- Estimated annual/lifetime value and the calculation range
- Deadline or reason it matters now
- Cash and liquidity required
- Important tradeoffs and assumptions
- Evidence and “show the math”
- A prefilled scenario or safe next action
- Accepted/dismissed outcome tracking so recommendations improve over time

**MVP completion:** At least eight high-confidence detectors, a common scoring
contract, deterministic tests, ranking in the Action Center, and outcome
tracking. Do not begin with a generic AI advice feed.

**Depends on:** Financial Action Center, existing tax/planning/investment
engines, goals, cash-flow forecast, and Financial Provenance.

**Effort:** L.

**Delivered:** Eight deterministic opportunity packs, a common weighted scoring
contract, value ranges and liquidity/tradeoff context, evidence-backed
calculation traces, prefilled next-step links, Action Center ranking, and
deterministic tests.

---

## P0 - Universal Financial Provenance

**Status:** Implemented 2026-07-23.

**Outcome:** Any material number or recommendation can answer, “Where did this
come from, how was it calculated, and how current is it?”

**What:** Introduce common `EvidenceRef` and `CalculationTrace` contracts for
reports, tools, and actions. A trace can point to transactions, splits,
accounts, statements, receipts, payslips, prices, FX rates, categorization
rules, tax tables, assumptions, and intermediate calculations.

**MVP:**

1. “Explain this number” drill-through for dashboard KPIs, tax estimates,
   balances, net worth, cash-flow forecast, and Action Center dollar impacts.
2. Source badges for statement/receipt/payslip/manual/SimpleFIN provenance.
3. Price and FX quote timestamps with stale-data warnings.
4. Reconciliation state plus a per-book “verified through” date.
5. Exportable calculation/evidence manifest for accountant share links and
   tax packages.
6. Stable trace identifiers so a saved decision remains auditable after data
   changes.

**Architecture rule:** New report endpoints should return trace metadata or a
trace token instead of making each page invent a bespoke drill-down query.

**Depends on:** Existing report drill-downs, receipt/statement matching, price
audit, change history, and reconciliation metadata.

**Effort:** L.

**Delivered:** Stable trace IDs, evidence/source contracts, calculation steps,
source and stale-price badges, Explain drill-through for Action Center impacts
and dashboard KPIs, trace tokens on balances, estimated tax, and cash-flow
forecasts, per-book verified-through dates, retained decision snapshots, and an
exportable evidence manifest.

---

## P1 - Living Financial Plan of Record

**Outcome:** Turn the Scenario Sandbox from a one-time calculator into a living
plan continuously reconciled against the real books.

**What:**

- Save a scenario as the household’s adopted baseline plan.
- Model dated life events such as a job change, child, move, home purchase,
  rental, sabbatical, retirement, education, vehicle replacement, or business
  transition.
- Rerun the plan monthly using actual balances, income, spending, taxes,
  contributions, inflation, and market results.
- Explain changes in goal probability, liquidity, tax exposure, net worth, and
  FIRE date.
- Maintain a decision journal: alternatives considered, assumptions, selected
  action, expected impact, and actual outcome.

**MVP:**

1. Adopt, version, and archive plans.
2. Life-event timeline and reusable event templates.
3. Monthly actual-versus-plan update with cause attribution.
4. Plan-impact link on every relevant Opportunity Engine item.
5. Guardrails for minimum cash, debt payoff, contribution priorities, and goal
   deadlines.

**Depends on:** Scenario Sandbox, goals, budgets, cash-flow forecast, tax
estimator, FIRE/drawdown engines, and Universal Financial Provenance.

**Effort:** L.

---

## P1 - Unified Money Timeline

**Outcome:** One chronological view shows what will happen, what may happen, and
what the user must do.

**What:** Normalize scheduled transactions, bills, invoices, tax deadlines,
renewals, vesting, RMDs, bond coupons/maturities, warranties, home maintenance,
insurance events, goal deadlines, and planned capital replacement into a
shared `FinancialEvent` contract.

**MVP:**

1. Day/month/year views with expected cash impact and confidence.
2. Event adapters for existing scheduled transactions, compliance calendar,
   fixed income, renewals, equity compensation, home tasks, invoices/bills,
   goals, and report schedules.
3. Links between timeline events, cash-flow forecast, Action Center, and the
   adopted plan.
4. Conflict detection: projected low cash, duplicate obligations, missed
   contribution windows, and overdue actions.
5. Expanded tokenized iCal feeds with per-domain filters.

**Depends on:** Existing recurrence, compliance, renewal, home-task, fixed-income,
equity-compensation, invoice, and iCal services.

**Effort:** M-L.

---

## P1 - Family Office / Cross-Book Consolidation

**Outcome:** A household, its businesses, farms, rentals, nonprofits, and future
trusts can be understood as one financial graph without corrupting the
boundaries of their individual books.

**What:**

1. Extend book links into a typed entity/ownership graph.
2. Consolidated balance sheet, income statement, cash flow, net worth, tax
   context, liquidity, and opportunity view.
3. Match inter-book transfers and propose eliminations.
4. Ownership look-through for business profit, property, and investment
   exposure.
5. Global document search, Ask Your Books, Action Center, and Money Timeline
   across the authorized graph.
6. Advisor/accountant sharing scoped to selected entities and reports.

**MVP:** Household plus linked businesses, ownership percentages, consolidated
net worth/P&L/cash flow, transfer matching, and explicit elimination previews.
Do not silently combine books or currencies.

**Depends on:** Existing book links, RBAC, tax linked-business support,
multi-currency conversion, Universal Financial Provenance, and Action Center.

**Effort:** L-XL.

---

## P2 - Safe Operator Agent

**Outcome:** “Ask Your Books” can complete bounded financial work, not merely
answer questions.

**Safety contract:**

- The agent calls typed domain commands; it never receives unrestricted
  write-SQL access.
- Every material operation produces a preview and balanced-diff validation.
- Approval is scoped to the proposed operation.
- Execution creates an audit entry and supports undo where the domain permits.
- The response links to evidence and separates facts from assumptions.

**Initial intents:**

1. Prepare the weekly review or month-end close.
2. Categorize selected transactions and create reusable rules.
3. Match receipts/statements and explain ambiguous matches.
4. Create or modify a scheduled transaction from ledger history.
5. Build and compare a scenario, then adopt approved plan changes.
6. Prepare an accountant/tax package and request missing evidence.
7. Draft a budget/funding-rule adjustment from an accepted opportunity.
8. Explain and resolve a Data Health issue.

**Gate:** Build only after the Action Center, provenance contracts, and domain
command previews are stable. Generic proactive chat is not the differentiator;
auditable action is.

**Effort:** L-XL.

---

# Integrated feature packs

These remain valuable, but they should land as reusable data, detector, event,
and action packs rather than isolated pages.

## P1 - Business Cash-Conversion Pack

### Invoice Payment Links and Client Portal

**What:** Add Stripe and/or PayPal “Pay now” support to public invoices,
auto-record cleared payments and processor fees from signed webhooks, and
extend the public view into a lightweight portal for open invoices, payment
history, and estimate accept/decline.

**Why:** Invoices, estimates, dunning, recurring billing, settlement import, and
public views exist, but the money loop does not close.

**Integration:**

- Payment due/failed/cleared events appear in the Money Timeline.
- Failed and overdue payments become Action Center items.
- Webhook postings link invoice → payment → fee → settlement → reconciliation
  through Financial Provenance.
- Estimate acceptance uses the existing estimate-to-invoice conversion.

**Implementation notes:** Store processor credentials per book in Connections.
Reuse settlement-import split logic for fees and refunds.

**Effort:** M-L.

### P2 - Job Costing and Project Profitability

Join tracked labor, employee rates, materials/vouchers, job expenses, invoiced
revenue, and unbilled WIP into a per-job margin view. Emit actions for unbilled
time/expense, margin erosion, and overdue collections. Expenses use explicit job
links with tag fallback.

**Depends on:** Jobs, time tracking, invoices, vouchers, and Action Center.

**Effort:** M.

### P2 - Employee Expense Reimbursement

Add submitted → approved → posted/rejected workflow over the receipt inbox.
An employee-role user submits a reimbursable receipt; an approver creates a
voucher in one action. Surface approvals in the Action Center and payment due
dates in the Money Timeline.

**Depends on:** Receipts, RBAC, employees, vouchers, notifications, and Action
Center.

**Effort:** S-M.

---

## P2 - Property, Protection, and Capital-Replacement Pack

### Rental Property Management

Add properties/units, tenants, leases, escalations, renewal reminders, rent roll,
security-deposit liabilities, late-fee rules, and per-tenant ledgers/statements
on top of Schedule E and existing customer/recurring-invoice machinery.

**Integration:** Lease and rent events feed the Timeline; overdue rent and lease
renewals feed the Action Center; property cash flow feeds the Living Plan and
cross-book consolidation; every Schedule E figure remains traceable.

**Effort:** L.

### Insurance Coverage-Gap Analysis

Track policies, limits, sub-limits/riders, deductibles, premiums, renewals, and
covered entities. Compare home-inventory replacement value against coverage,
flag category sub-limit gaps, and export a claims package containing photos,
values, receipts, and policy evidence.

**Integration:** Renewal and coverage-gap actions, Timeline events, plan stress
tests, and a shared policy model for life/health/property coverage.

**Effort:** M.

### Home Capital-Replacement Forecast

Add expected lifespan and replacement cost to roofs, HVAC, water heaters,
appliances, and other inventory. Inflate known costs, show the replacement
timeline, and propose envelope funding rules such as “set aside $110/month.”

**Integration:** Capital events feed Timeline and Living Plan; funding gaps
become ranked opportunities; accepted recommendations create previewed funding
rules.

**Effort:** M.

### Life Insurance Needs Analysis

Calculate per-spouse coverage need from actual income, debts, education goals,
final expenses, liquid assets, and existing policies. Start with DIME, then add
a survivor-cash-flow mode using the FIRE engine.

**Integration:** Uses the shared policy model, emergency information, Living
Plan stress tests, and coverage-gap actions.

**Effort:** S-M.

---

## P2 - Household Cost and Resilience Pack

### Personal Price Index

Normalize recurring receipt line items and units, track the household’s actual
price history, and compare personal inflation with BLS categories. Start with
the top recurring items rather than attempting universal normalization.

**Integration:** Emit evidence-backed price-increase and substitution
opportunities. Link each result to receipts and ledger transactions.

**Effort:** M.

### Healthcare Deductible and Open-Enrollment Comparator

Track deductible/OOP progress by plan and family member. Replay one to three
years of actual claims against candidate HDHP/HSA and PPO designs, including
premiums, expected out-of-pocket costs, and HSA tax effects.

**Integration:** Deductible milestones feed Timeline; open-enrollment choices
become plan scenarios and ranked opportunities; EOBs remain attached evidence.

**Effort:** L.

### P3 - 529 and Education Savings Planner

Add per-child education goals, public/private cost projections, tuition
inflation, 529 balances, state deduction tracking, and glide-path guidance.
Later phases may cover five-year gift elections and SECURE 2.0 529-to-Roth
rollovers.

**Integration:** Education events and contributions feed Living Plan, Timeline,
and Next Best Dollar ranking.

**Effort:** M.

### P3 - Utility Usage and Solar Payback

Extract kWh, therms, and water usage from bills so rate increases can be
separated from consumption changes. Use actual rates and usage for solar-payback
scenarios.

**Integration:** Price/usage anomalies become actions; solar is a Living Plan
capital scenario; source bills provide provenance.

**Effort:** M.

### P3 - Family Banking and Kids’ Allowance

Create honest liability-backed child balances, scheduled allowances,
chore-based credits, savings goals, optional parent matching, and a restricted
kid-facing view.

**Integration:** Allowance and goal events feed Timeline; parent approvals use
Action Center; RBAC scopes the child view.

**Effort:** M-L.

### P3 - Trip and Vacation Budgeting

Model a trip as a tag, envelope, and date range with a savings target, live
spend, and post-trip plan-versus-actual report. Offer a current-trip toggle in
Quick Add and review suggested date-range auto-tags.

**Integration:** A trip is a first-class Living Plan event, funding opportunity,
and temporary Action Center context rather than a standalone accounting silo.

**Effort:** S.

---

## P2 - Mobility and Vehicle Pack

### Mileage Log

Capture date, purpose, vehicle, miles or odometer pair, and business-use
classification. Maintain annual IRS business/medical/charity mileage rates and
feed deductions to Schedules C, E, and F. Provide thumb-first mobile entry.

**Effort:** S-M.

### Fuel-Tracker Integration

Ingest vehicles and fill-ups from `../fuel-tracker`, then match total/date
against SimpleFIN gas purchases and attach gallons, price per gallon, location,
odometer, and MPG.

Preferred integration: token-authenticated `GET /api/fillups?since=` polled by a
BullMQ job, with source ID dedupe and a one-time vehicle-to-asset mapping.
Webhook push is an acceptable alternative; direct database access is not the
preferred contract.

**Effort:** M.

### P3 - Vehicle Total Cost of Ownership

Combine fuel, insurance, maintenance, registration, depreciation, and mileage
into monthly run rate and cost per mile. Add evidence-backed repair-versus-
replace scenarios using the Living Plan rather than a context-free warning.

**Depends on:** Mileage Log, Fuel-Tracker integration, assets/depreciation, and
service-log patterns.

**Effort:** M.

---

# Core workflow and connector backlog

## P1 - Scheduled Transactions: Edit and Create from Existing

1. Reuse `CreateScheduledPanel` in edit mode for name, recurrence, splits,
   amounts, dates, and auto-create/notify settings.
2. Add “Schedule” to ledger transaction actions and prefill it from the selected
   transaction.
3. Optionally infer a likely cadence from transaction history.
4. Add a validated update endpoint such as
   `PATCH /api/scheduled-transactions/[guid]`.

This is promoted because the Action Center and Safe Operator Agent need a
complete scheduled-transaction command surface.

**Effort:** M.

---

## P1 - Reconciliation UX Discovery and Continuous Close

Use real books to identify why the current flow feels wrong. Measure clicks,
time-to-tie-out, abandoned reconciliations, unclear balance states, and missing
transaction handling.

The redesign should connect statement import, manual reconcile, connection
balances, transaction review, and Data Health into the Action Center. Accounts
should expose reconciliation coverage and a verified-through date.

**Effort:** Discovery first; implementation TBD.

---

## P3 - Payslip Structured-Source Follow-Up

PDF/AI payslip extraction and employer templates are shipped. The remaining
scope is an optional QuickBooks Online/Intuit Payroll connector, subject to
developer approval and product access. Preserve SimpleFIN deposit enrichment,
dedupe, balanced posting, and employer contribution metadata.

**Existing design:** `docs/superpowers/specs/2026-03-24-payslip-integration-design.md`

**Effort:** M-L after external access is available.

---

## P3 - Scheduled Book Sync to External PostgreSQL / GnuCash Desktop

Export one web book on a schedule into a vanilla GnuCash-compatible PostgreSQL
database, with initial seed, incremental changes, conflict detection, schema
compatibility, and securely stored per-book target credentials.

Evaluate application-level sync before logical replication. Never silently
overwrite a desktop-modified target; conflicts must become Action Center items.

**Depends on:** Multi-book support, authorization, audit history, and a clear
conflict policy.

**Effort:** L.

---

## P3 - Accounts API: Remove Book Name from `fullname`

Return `Assets:Checking` rather than
`Crawford Personal Finances:Assets:Checking`, with `book_name` as a separate
field. Update both flat-account and hierarchy responses and remove redundant
client-side stripping.

**Effort:** XS.

---

## P4 - Receipt AI Re-Extraction Batch Job

Add “Re-extract all” in AI settings for receipts still using regex extraction.
Queue jobs through BullMQ, expose progress through the existing job-progress
system, and avoid reprocessing already-AI-extracted receipts unless explicitly
requested.

**Effort:** S.

---

# Correctness and reliability backlog

## Completed - Farm Correctness and Follow-Ups

- [x] **Tool-config concurrency:** Partial unique indexes now distinguish
  personal singletons, shared-book singletons, and account-associated
  multi-instance tools. Singleton writes use PostgreSQL upserts.
- [x] **Multi-currency farm sums:** Schedule F and the farm analyzer convert
  posting-date transaction values through `findExchangeRate()` into the book
  currency. Missing historical rates stop the report with an explicit 422.
- [x] **Farm scope:** Official farm roots and pinned assumptions are shared
  per book, matching the existing book-scoped Schedule F mappings. Startup
  promotes the newest legacy personal farm config to the shared scope.
- [x] **Household-income context:** The annualization/exclusion helper lives
  in `src/lib/tax/household-income-context.ts` and is shared by farm and
  S-corp analysis.
- [x] **NC three-year average:** The analyzer derives the three preceding
  years from book history and applies the statutory prior-year OR
  three-year-average qualification test.
- [x] **Graft farm accounts:** Existing books can receive the Schedule F chart
  through idempotent, type-aware `addTemplateAccounts()`, without routing
  assets, liabilities, expenses, or equity through an INCOME-only helper.
- [x] **E-595QF/E-595CF tracking:** Documents stores certificate issue,
  expiration, and return-copy dates. Obligations feed the Action Center and
  the compliance calendar/iCal timeline; E-595CF expiration is inferred from
  its issue year when omitted.

---

# Backlog admission checklist

Before adding another feature to this file, answer:

1. What user decision or recurring workflow does it improve?
2. Does it emit an Action, Timeline event, Plan input, or evidence trace?
3. What existing engine or data does it reuse?
4. What calculation is deterministic and testable?
5. What is the preview/approval/undo behavior?
6. Is it single-book or cross-book, and how are currencies handled?
7. What measurable outcome proves it was useful?

If those answers are weak, improve an existing workflow instead of adding
another destination to the feature catalog.
