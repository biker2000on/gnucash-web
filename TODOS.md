# Product Roadmap and TODOs

Updated 2026-08-19.

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
5. [Done] Normalize existing dated obligations into the Money Timeline.
6. [Done] Let a scenario become an adopted Living Plan and reconcile it to actuals.
7. [Done] Extend book links into cross-book consolidation.
8. [Done] Add the Safe Operator Agent only after previewable domain commands
   are available.

Feature packs may ship alongside this sequence when they use the shared
contracts. They should not introduce a new private inbox, recommendation feed,
calendar model, scenario engine, or evidence format.

## Product education and discoverability

1. [Done 2026-07-27, v0.22.0.0] Refresh the public marketing site around the
   explainable financial operating system, publish a searchable capability
   catalog, and launch public documentation with getting started, seven core
   workflows, and OpenAPI reference.
2. [Done 2026-07-27, v0.23.0.0] Publish operating reference for every
   registered feature, core financial concepts, and administrator/recovery
   guidance; add route-aware in-app Help, documentation commands in Ctrl+K,
   full-site search, and CI coverage enforcement.

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

**Status:** Implemented 2026-07-23.

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

**Delivered:** Scenario adoption from the sandbox, immutable plan versions,
archive support, reusable typed life-event templates, plan events on the shared
timeline, automatic once-per-month actual reconciliation, deterministic cause
attribution for income/spending/markets/liquidity, net-worth/tax/FIRE variance,
a decision journal, plan-impact links on ranked opportunities, and tested cash,
debt, contribution-priority, and goal-deadline guardrails.

---

## P1 - Unified Money Timeline

**Status:** Implemented 2026-07-23.

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

**Delivered:** Shared typed `FinancialEvent` and conflict contracts; day, month,
and year views; expected cash and confidence; adapters for scheduled
transactions, compliance, fixed income, RMDs, renewals, warranties, home tasks,
invoices/bills, goals, planned equity vesting, report schedules, and adopted
plan events; low-cash, duplicate, overdue, and missed-contribution-window
detection; source/evidence links; family-graph aggregation; and tokenized iCal
filters for every event domain.

---

## P1 - Family Office / Cross-Book Consolidation

**Status:** Implemented 2026-07-23.

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

**Delivered:** A permission-intersected typed ownership graph, household and
linked-business consolidation with ownership look-through, net worth, P&L,
cash flow, investments, and liquidity, explicit currency conversion/exclusion
warnings, cross-book cash-transfer matching, durable presentation-only
elimination approvals, global entity-document and receipt-OCR search, and
family-scoped Ask Your Books, Action Center, and Money Timeline. Existing
per-book RBAC remains the access boundary for advisor/accountant sharing.

---

## P2 - Safe Operator Agent

**Status:** Implemented 2026-07-24.

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

**Delivered:** A bounded Operator page routes supported natural-language intents
to typed commands, shows facts/assumptions/evidence and a balanced diff, requires
explicit approval, records durable idempotent execution, and offers undo where
the command permits it. Unsupported write requests are refused rather than
translated to arbitrary SQL.

---

# Integrated feature packs

These remain valuable, but they should land as reusable data, detector, event,
and action packs rather than isolated pages.

## P1 - Business Cash-Conversion Pack

### Invoice Payment Links and Client Portal

**Status:** Implemented 2026-07-24.

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

**Delivered:** Per-book encrypted Stripe credentials and account mappings,
signed/deduplicated webhook processing, automatic invoice payment and processor
fee posting, public payment history and Pay now, estimate accept/decline, plus
failed/cleared payment signals in the Action Center and Money Timeline.

### P2 - Job Costing and Project Profitability

**Status:** Implemented 2026-07-24.

Join tracked labor, employee rates, materials/vouchers, job expenses, invoiced
revenue, and unbilled WIP into a per-job margin view. Emit actions for unbilled
time/expense, margin erosion, and overdue collections. Expenses use explicit job
links with tag fallback.

**Depends on:** Jobs, time tracking, invoices, vouchers, and Action Center.

**Effort:** M.

**Delivered:** Job reports now combine invoice revenue and collections, tracked
labor at employee rates, unbilled WIP, vendor bills, explicitly linked costs,
and tag fallback into gross profit and margin. The Action Center surfaces
unbilled work, margin erosion, and overdue collections.

### P2 - Employee Expense Reimbursement

**Status:** Implemented 2026-07-24.

Add submitted → approved → posted/rejected workflow over the receipt inbox.
An employee-role user submits a reimbursable receipt; an approver creates a
voucher in one action. Surface approvals in the Action Center and payment due
dates in the Money Timeline.

**Depends on:** Receipts, RBAC, employees, vouchers, notifications, and Action
Center.

**Effort:** S-M.

**Delivered:** Employees can submit receipt-backed expenses, approvers use a
previewed command to approve or reject them, approval creates a draft voucher,
and voucher posting advances the request. Approval work and payment dates feed
the Action Center and Money Timeline.

---

## P2 - Property, Protection, and Capital-Replacement Pack

### Rental Property Management

**Status:** Implemented 2026-07-26.

Add properties/units, tenants, leases, escalations, renewal reminders, rent roll,
security-deposit liabilities, late-fee rules, and per-tenant ledgers/statements
on top of Schedule E and existing customer/recurring-invoice machinery.

**Integration:** Lease and rent events feed the Timeline; overdue rent and lease
renewals feed the Action Center; property cash flow feeds the Living Plan and
cross-book consolidation; every Schedule E figure remains traceable.

**Effort:** L.

**Delivered:** A book-scoped rental portfolio models properties, units, tenants,
leases, escalation terms, renewal dates, rent due dates, late fees, security
deposit liabilities, and payment ledgers. The rent roll calculates current
collections and overdue balances, exports per-tenant statements, links to
Schedule E property definitions, and emits rent/renewal actions and Timeline
events.

### Insurance Coverage-Gap Analysis

**Status:** Implemented 2026-07-26.

Track policies, limits, sub-limits/riders, deductibles, premiums, renewals, and
covered entities. Compare home-inventory replacement value against coverage,
flag category sub-limit gaps, and export a claims package containing photos,
values, receipts, and policy evidence.

**Integration:** Renewal and coverage-gap actions, Timeline events, plan stress
tests, and a shared policy model for life/health/property coverage.

**Effort:** M.

**Delivered:** A shared policy model tracks property, auto, umbrella, life,
health, and other coverage with limits, deductibles, premiums, renewals,
covered entities, category sub-limits, and document references. It compares
home-inventory replacement value against whole-policy and category limits,
emits renewal and coverage-gap actions/events, and exports a ZIP claims package
containing inventory, photos, linked receipts, and masked policy evidence.

### Home Capital-Replacement Forecast

**Status:** Implemented 2026-07-26.

Add expected lifespan and replacement cost to roofs, HVAC, water heaters,
appliances, and other inventory. Inflate known costs, show the replacement
timeline, and propose envelope funding rules such as “set aside $110/month.”

**Integration:** Capital events feed Timeline and Living Plan; funding gaps
become ranked opportunities; accepted recommendations create previewed funding
rules.

**Effort:** M.

**Delivered:** Major home systems carry installed year, expected life,
replacement cost, inflation, and funded amount. The deterministic forecast
calculates replacement year, future cost, funding gap, and required monthly
funding; near-term replacements feed the Action Center and every replacement
feeds the Money Timeline.

### Life Insurance Needs Analysis

**Status:** Implemented 2026-07-26.

Calculate per-spouse coverage need from actual income, debts, education goals,
final expenses, liquid assets, and existing policies. Start with DIME, then add
a survivor-cash-flow mode using the FIRE engine.

**Integration:** Uses the shared policy model, emergency information, Living
Plan stress tests, and coverage-gap actions.

**Effort:** S-M.

**Delivered:** Per-person DIME and survivor-cash-flow models use income,
replacement years, debts, education goals, final expenses, liquid assets,
existing coverage, and survivor income/expense assumptions. The larger modeled
gap becomes an evidence-backed coverage action.

---

## P2 - Household Cost and Resilience Pack

### Personal Price Index

**Status:** Implemented 2026-07-26.

Normalize recurring receipt line items and units, track the household’s actual
price history, and compare personal inflation with BLS categories. Start with
the top recurring items rather than attempting universal normalization.

**Integration:** Emit evidence-backed price-increase and substitution
opportunities. Link each result to receipts and ledger transactions.

**Effort:** M.

**Delivered:** Receipt OCR lines are normalized into comparable recurring
items, unit prices, source receipts, observed price change, and annualized
change. The household index is shown beside current official BLS CPI category
benchmarks fetched from the public API.

### Healthcare Deductible and Open-Enrollment Comparator

**Status:** Implemented 2026-07-26.

Track deductible/OOP progress by plan and family member. Replay one to three
years of actual claims against candidate HDHP/HSA and PPO designs, including
premiums, expected out-of-pocket costs, and HSA tax effects.

**Integration:** Deductible milestones feed Timeline; open-enrollment choices
become plan scenarios and ranked opportunities; EOBs remain attached evidence.

**Effort:** L.

**Delivered:** Household members' allowed claims can be replayed across current
and candidate plans using annual premiums, family deductible, coinsurance,
out-of-pocket maximum, employer HSA funding, employee HSA contributions, and
marginal-rate tax effects. Lower-cost candidates become ranked decisions in
the Action Center.

### P3 - 529 and Education Savings Planner

**Status:** Implemented 2026-07-26.

Add per-child education goals, public/private cost projections, tuition
inflation, 529 balances, state deduction tracking, and glide-path guidance.
Later phases may cover five-year gift elections and SECURE 2.0 529-to-Roth
rollovers.

**Integration:** Education events and contributions feed Living Plan, Timeline,
and Next Best Dollar ranking.

**Effort:** M.

**Delivered:** Per-student plans project inflated annual education costs,
current 529 growth, planned and required monthly contributions, state deduction
room, and a time-based growth/preservation glide path. Funding gaps feed the
Action Center and enrollment milestones feed the Money Timeline with calculation
provenance.

### P3 - Utility Usage and Solar Payback

**Status:** Implemented 2026-07-26.

Extract kWh, therms, and water usage from bills so rate increases can be
separated from consumption changes. Use actual rates and usage for solar-payback
scenarios.

**Integration:** Price/usage anomalies become actions; solar is a Living Plan
capital scenario; source bills provide provenance.

**Effort:** M.

**Delivered:** Electric, gas, and water bills track usage, unit cost, provider,
source transaction, and source receipt. Completed receipt OCR produces reviewed
bill suggestions, rate and consumption changes are calculated separately, and
the solar scenario uses actual electric rates with incentives, degradation,
maintenance, inflation, payback, and lifetime savings.

### P3 - Family Banking and Kids’ Allowance

**Status:** Implemented 2026-07-26.

Create honest liability-backed child balances, scheduled allowances,
chore-based credits, savings goals, optional parent matching, and a restricted
kid-facing view.

**Integration:** Allowance and goal events feed Timeline; parent approvals use
Action Center; RBAC scopes the child view.

**Effort:** M-L.

**Delivered:** Each child ledger links to a GnuCash liability account and tracks
approved balances, scheduled allowances, pending chore credits, deposits,
spending, automatic parent matches, and savings goals. Parent work feeds the
Action Center, allowance dates feed the Timeline, and a scoped read-only child
view hides pending approvals and parent controls.

### P3 - Trip and Vacation Budgeting

**Status:** Implemented 2026-07-26.

Model a trip as a tag, envelope, and date range with a savings target, live
spend, and post-trip plan-versus-actual report. Offer a current-trip toggle in
Quick Add and review suggested date-range auto-tags.

**Integration:** A trip is a first-class Living Plan event, funding opportunity,
and temporary Action Center context rather than a standalone accounting silo.

**Effort:** S.

**Delivered:** Trips are date-ranged envelopes with budgets, savings targets,
funded amounts, live expenses, plan variance, and monthly funding requirements.
Reviewed transaction suggestions use dates and trip context, while the current
trip toggle applies its configured tag to online and offline Quick Add entries.
Funding gaps and trip dates feed the Action Center and Money Timeline.

---

## P2 - Mobility and Vehicle Pack

### Mileage Log

**Status:** Implemented 2026-07-26.

Capture date, purpose, vehicle, miles or odometer pair, and business-use
classification. Maintain annual IRS business/medical/charity mileage rates and
feed deductions to Schedules C, E, and F. Provide thumb-first mobile entry.

**Effort:** S-M.

**Delivered:** A mobile-friendly vehicle and trip log records date, purpose,
description, miles or odometer evidence, and Schedule C/E/F classification.
The deduction engine applies effective-date IRS rates—including the July 2026
mid-year change—and reports substantiated miles and deduction by schedule.

### Fuel-Tracker Integration

**Status:** Implemented 2026-07-26.

Ingest vehicles and fill-ups from `../fuel-tracker`, then match total/date
against SimpleFIN gas purchases and attach gallons, price per gallon, location,
odometer, and MPG.

Preferred integration: token-authenticated `GET /api/fillups?since=` polled by a
BullMQ job, with source ID dedupe and a one-time vehicle-to-asset mapping.
Webhook push is an acceptable alternative; direct database access is not the
preferred contract.

**Effort:** M.

**Delivered:** Per-book encrypted Fuel Tracker connection settings consume the
read-only `/api/v1/vehicles` and paginated `/api/v1/fillups` contracts, retain
one-time vehicle mappings, deduplicate by immutable source ID, incrementally
refresh changed fill-ups, and match amount/date candidates to GnuCash
transactions. A nightly worker sync and manual run share the same idempotent
service; unmatched evidence feeds the Action Center.

### P3 - Vehicle Total Cost of Ownership

**Status:** Implemented 2026-07-26.

Combine fuel, insurance, maintenance, registration, depreciation, and mileage
into monthly run rate and cost per mile. Add evidence-backed repair-versus-
replace scenarios using the Living Plan rather than a context-free warning.

**Depends on:** Mileage Log, Fuel-Tracker integration, assets/depreciation, and
service-log patterns.

**Effort:** M.

**Delivered:** Each vehicle combines linked asset depreciation, Fuel Tracker
fill-ups, insurance policies, registration, maintenance, and mileage into an
annual and monthly run rate plus cost per mile. Evidence-backed
repair-versus-replace scenarios compare repair cost, remaining life, current
value, replacement price, and financing while surfacing decisions through the
Action Center with calculation provenance.

---

## P2 - Tax Deduction and Compliance Pack

### Charitable Giving and Deduction Bunching

**Status:** Implemented 2026-08-01.

**What:** Track cash and non-cash donations with fair-market-value evidence
(photos, receipts, and acknowledgment letters through the document vault),
charity mileage through the existing mileage engine and its IRS charity rate,
and QCDs once RMD age applies. Add a deterministic "bunch two years of giving
into one" scenario that compares itemizing against the standard deduction,
including donor-advised-fund front-loading.

**Why:** The largest common tax surface the roadmap does not touch. Donation
substantiation (Form 8283 thresholds, acknowledgment letters) is an evidence
problem the document vault already solves elsewhere.

**Integration:** Donation deadlines and acknowledgment follow-ups feed the
Money Timeline; bunching and QCD opportunities rank in Next Best Dollar; every
deduction figure traces to its receipts and valuations; bunching becomes a
Living Plan scenario.

**Effort:** M.

**Delivered:** A book-scoped giving profile tracks cash, non-cash, and QCD
donations with substantiation flags (acknowledgment letters at $250, Form
8283 at $500, appraisals at $5,000), charity mileage from the existing
mileage log at the IRS charity rate, QCD eligibility by age, and a
deterministic two-year bunching comparison using the repo's standard
deduction figures. Substantiation gaps and bunching/QCD decisions feed the
Action Center with formulas and traces; year-end and acknowledgment dates
feed the Money Timeline at `/planning/giving`.

### 1099 Contractor Compliance

**Status:** Implemented 2026-08-01.

**What:** Detect vendors paid over the reporting threshold from ledger history,
track W-9 collection status in the document vault, generate 1099-NEC/MISC
data for filing or export, and place the January deadlines on the compliance
calendar.

**Why:** Business books already have vendors, vouchers, and jobs, but nothing
closes the annual information-return loop. Threshold detection is purely
deterministic ledger math.

**Integration:** Missing W-9s and unfiled forms become Action Center items;
filing deadlines feed the Money Timeline and compliance iCal; every reported
box amount traces to its source payments.

**Effort:** S-M.

**Delivered:** Extends the existing 1099 worksheet with W-9 request/receipt
tracking, per-year filing status (`gnucash_web_vendor_1099_filings`), a pure
compliance engine (Jan 31 due dates, threshold detection), missing-W-9 and
unfiled-1099 Action Center items that escalate as the deadline approaches,
filing-deadline Timeline events, and W-9/filing columns in the CSV export.
TINs remain masked everywhere.

---

## P2 - Farm Production and Direct-Sales COGS Pack

**Status:** Implemented 2026-08-01 (Beez Trackz connector held in reserve).

**What:** Track production (honey, eggs, produce) from harvest through
inventory to sale: harvest/production logs with quantities, per-unit cost
buildup, inventory on hand, and sales-channel tracking (farmers market,
wholesale, direct) flowing into Schedule F cost-of-goods and income lines.

**Beez Trackz integration:** The apiary side of production should come from
`../beez-trackz`, which already models harvests, bottling runs, lots, expenses,
customers, orders, and wholesale pricing behind its Go `/api/v1` contract.
Follow the Fuel Tracker pattern: per-book encrypted connection settings, a
token-authenticated read-only API polled by a BullMQ worker, immutable
source-ID dedupe, and a one-time mapping of Beez Trackz sales channels and
expense categories to GnuCash accounts. This may include updating Beez Trackz
itself — e.g., adding or extending read endpoints for harvests, bottling
runs, order/payment status, and expenses with `since`-based incremental
pagination — so the integration contract is clean rather than scraped.

**Why:** The Schedule F machinery is deep, but the production-to-inventory-to
sale chain that generates its COGS and income figures is untracked. Honey
sales recorded in Beez Trackz and deposits in GnuCash currently never meet.

**Integration:** Unmatched Beez Trackz orders versus ledger deposits become
Action Center items; harvest and market dates feed the Money Timeline; every
Schedule F COGS and income figure traces to harvests, bottling runs, and
orders; per-channel margin feeds the farm analyzer.

**Depends on:** Schedule F engine, farm book templates, Fuel Tracker
connection pattern, and Action Center.

**Effort:** M-L (plus coordinated Beez Trackz API work).

**Delivered:** Products, harvests, sales by channel, inventory adjustments,
and annual input costs produce per-product on-hand quantities, allocated
unit costs, channel revenue, gross margin, COGS estimate, and inventory
value, with negative-stock, unlinked-revenue, and low-margin signals in the
Action Center, market-day Timeline events, and a Schedule F context panel at
`/business/farm-production`. Every harvest and sale carries
`source`/`sourceId` seam fields (`manual` today, `beez_trackz` reserved) so
the future connector can sync and dedupe without schema changes. The Beez
Trackz API connector itself remains open, pending that app's readiness.

---

## P3 - Estate and Beneficiary Readiness Pack

**Status:** Implemented 2026-08-01.

**What:** Track per-account beneficiary designations with staleness detection
keyed to Living Plan life events (marriage, birth, death, divorce), monitor
will/trust/POA/healthcare-directive document freshness in the vault, maintain
a survivor access runbook, and compute estate exposure against the federal and
state exemption.

**Why:** Low effort, high consequence-avoidance. The document vault, insurance
policy model, and emergency information already hold most of the data; nothing
currently notices when a designation goes stale.

**Integration:** Stale beneficiaries and expiring documents become Action
Center items; document review dates feed the Money Timeline; exposure math
carries calculation provenance; estate events become Living Plan stress tests.

**Effort:** S-M.

**Delivered:** Beneficiary designations with life-event and age staleness
detection, will/POA/directive freshness with review cycles, a core-document
coverage checklist, survivor runbook tracking, federal exemption exposure
(2026 OBBBA figure with portability assumption), and a 0-100 readiness
score at `/planning/estate`. Stale designations, document gaps, exposure,
and runbook staleness feed the Action Center; document review dates feed
the Money Timeline.

---

## P3 - Retirement Income Sequencing and Social Security Optimizer

**Status:** Implemented 2026-08-01.

**What:** Deterministic claiming-age comparison per spouse (including survivor
and spousal benefits), withdrawal-order modeling across taxable, tax-deferred,
and Roth accounts, and IRMAA cliff detection on modified AGI.

**Why:** The FIRE/drawdown engines and RMD timeline exist; this is the
decision layer on top of them. Claiming age and withdrawal order are among the
largest single retirement decisions and are fully deterministic.

**Integration:** Claiming windows and IRMAA thresholds feed the Money
Timeline; sequencing recommendations rank in Next Best Dollar with "show the
math"; the chosen strategy becomes an adopted Living Plan element reconciled
against actual benefits and withdrawals.

**Depends on:** FIRE/drawdown engines, tax estimator, RMD events, and Living
Plan.

**Effort:** M-L.

**Delivered:** Per-person claiming comparison at 62/FRA/70 using the
existing SSA parameter and PIA engines (monthly, lifetime with COLA,
breakevens, recommendation), a sequencing comparison run through the real
drawdown engine (taxable-first vs traditional-first with ending value and
total taxes), IRMAA tier headroom from the 2026 tables, and RMD start
context at `/planning/retirement-income`. Claiming, sequencing, and IRMAA
decisions feed the Action Center; a ninth Opportunity Engine pack ranks
claiming-delay and sequencing value in Next Best Dollar; age-62/FRA/70/RMD
milestones feed the Money Timeline.

---

# Core workflow and connector backlog

## P3 - Finish Household Identity Integration

**Status:** Implemented 2026-08-04.

**Delivered:** Healthcare claims carry an optional `memberRole` link (strict
dependent matching, stored-text fallback), the claim member picker seeds from
the roster, and `coveredByEmployerPlan` now flows from household settings into
plan-eligibility context. Family banking children link to roster dependents,
seed one ledger per named dependent, and show age from the on-file birthday;
the kid-view API resolves seeded ledgers instead of 404ing. Legacy text-only
profiles parse and compute identically (regression-tested); links are never
inferred from a name collision alone.

**Outcome:** A person is defined once, in household settings, and every pack
refers to that person. The app should behave as one integrated system rather
than a set of tools that each keep their own copy of the family.

Estate, retirement income, life insurance, and the 529 planner now resolve
people from the household roster (`loadHouseholdRoster` plus the pure
resolution helpers in `src/lib/resilience/household.ts`), seed themselves from
it, and inherit filing status from `EntityProfile`. Two packs still identify
people by loose text:

- **Healthcare comparator** — `HealthcareClaim.member` is a free-text string,
  so claims cannot be grouped by household member reliably and a rename
  silently splits a person's claim history. `EntityMember.coveredByEmployerPlan`
  already exists and should drive plan-eligibility context too.
- **Family banking** — `FamilyBankChild.name` is free text, though every child
  ledger corresponds to a household `dependent` with a birthday on file.

Apply the established pattern: an optional member link on the record, service
side resolution against the roster before the pure engine runs, seeding from
the roster when a pack is empty, and strict matching for dependents (role plus
normalized name, falling back to stored values on an ambiguous or missing
match rather than guessing). Existing profiles must keep parsing and computing
identically, with the link never inferred from a name collision alone.

**Depends on:** `src/lib/resilience/household.ts`, entity profile/members.

**Effort:** S-M.

---

## P1 - Action Center Signal Quality

**Status:** Implemented 2026-08-04.

**Delivered:** Review actions are source-gated (`source <> 'manual'`; a write-
path audit confirmed no path creates manual rows with `reviewed = FALSE`).
Savings-rate and category-spike detectors compare like-for-like first-N-days
windows with a day-7 floor and state the window in their trace; the point-in-
time detectors were audited and need no change. New `original_description`
column (idempotent raw-SQL migration) preserves the imported payee: set by
SimpleFIN/payslip imports, never overwritten on edit, consumed by new-merchant
detection, categorization rules, recurring detection, and duplicate matching,
and shown as "Imported as …" on transaction detail. No backfill for
already-renamed rows, as specified.

**Outcome:** Every item in the Action Center is worth reading. Today the
surface raises items the user can only dismiss, which trains them to ignore
the lane that is supposed to drive the weekly close.

**Evidence (production book, 2026-08-02):** all-time action outcomes are
dominated by dismissals — 83 notifications, 25 insights, 25 failed jobs, and
every one of the 12 transaction-review items ever raised were dismissed.

### Pay-cycle-aware savings rate

`detectSavingsRateDrop` (`src/lib/insights.ts`) compares the **partial**
current month against the average of six **complete** prior months. In the
first days of a month, income is usually zero because the paycheck has not
landed, so the rate reads 0% and the detector reports a 29-point collapse.
The comparison is not like-for-like.

The detector should understand the household's pay cycle before judging a
partial month. Options, in preference order:

1. Derive the expected pay dates from payslip history and recurring income
   deposits (both already modelled) and suppress the comparison until the
   month's expected income has actually arrived.
2. Compare month-to-date against prior months truncated to the same day of
   month, so both sides cover the same fraction of a cycle.
3. As a floor, require a minimum elapsed fraction of the month before the
   detector may fire at all.

Whichever is chosen, the trace must state the window and the assumption. The
same partial-period flaw should be audited in the other monthly detectors
(category spike, net-worth milestone).

### Suppress review noise for transactions that need no review

`transactionReviewActions` (`src/lib/financial-actions/sources.ts`) selects on
`reviewed = FALSE` alone, without considering `source`. It should never raise
an item for a transaction the user entered manually — authoring a transaction
is the review — and never re-raise one already reviewed after import.
`gnucash_web_transaction_meta` already carries `source` (`manual`, `simplefin`,
`payslip`) and defaults `reviewed` to true, so the gate is available; the
adapter simply does not use it. Confirm no write path creates a manual
transaction with `reviewed = FALSE`.

### Preserve the original imported payee alongside a rename

`gnucash_web_transaction_meta` has no column for the description an import
arrived with, so renaming an imported transaction destroys the payee
permanently. This is not an edge case — the user's convention is to name
transactions by **what was purchased**, not by the vendor.

Real examples from the production book: raw imports look like
`HARBOR FREIGHT PAYMENT`, `Publix #1548 Boone Nc`, and
`CALDWELL COUNTY UTILITY~ Future Amount: 29.65 ~ Tran: ACHDW`, while renamed
ones read `pajamas`, `beach chairs`, `Selle Italia SLR Boost S3`, or fold the
vendor into the item as `Dollar General fans` and
`Walmart buckets for honey harvest`.

Because `detectNewMerchants` keys on the *description*, every rename to an
item name over $100 registers as a merchant never paid before — noise that
cannot be fixed without keeping the original payee.

Work:

1. Store the import-time description (and the raw payee string where the
   provider supplies one) on the transaction meta row; never overwrite it on
   edit.
2. Point merchant-identity logic — new-merchant detection, categorization
   rules, recurring/subscription matching, duplicate detection — at the
   preserved payee rather than the display description.
3. Surface both in the UI: show the user's name, reveal the original on the
   transaction detail so a bank line can still be traced.
4. Backfill is not possible for transactions already renamed; state that
   plainly rather than guessing a vendor from the item name.

**Depends on:** transaction meta, SimpleFIN import, insights, categorization
rules, Action Center.

**Effort:** M.

---

## P1 - Scheduled Transactions: Edit and Create from Existing

**Status:** Implemented 2026-07-24.

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

**Delivered:** Scheduled transactions can now be edited through the shared
panel and validated PATCH endpoint, or created from a ledger transaction with
prefilled splits. Both create and update operations use a durable preview,
explicit approval, audit trail, and reversible command state.

---

## P1 - Reconciliation UX Discovery and Continuous Close

**Status:** Implemented 2026-07-24.

Use real books to identify why the current flow feels wrong. Measure clicks,
time-to-tie-out, abandoned reconciliations, unclear balance states, and missing
transaction handling.

The redesign should connect statement import, manual reconcile, connection
balances, transaction review, and Data Health into the Action Center. Accounts
should expose reconciliation coverage and a verified-through date.

**Effort:** Discovery first; implementation TBD.

**Delivered:** Continuous Close measures account-level reconciliation coverage,
verified-through dates, stale and never-reconciled accounts, clicks,
time-to-tie-out, abandoned sessions, and interaction counts. The reconciliation
report presents these metrics and routes each gap into manual reconciliation
and the Action Center.

---

## P3 - Multi-Window / Multi-Monitor Pop-Out Panes

**Status:** Implemented 2026-08-01.

**Outcome:** The weekly close and other review-heavy workflows span two
monitors: a driving list on one screen and the work surface on the other, so
triage never bounces a single window between list and detail.

**What:** Let selected panes pop out into separate same-origin browser
windows with bidirectional state sync (BroadcastChannel or equivalent).
Pop-outs are plain authenticated app routes — no new session or token
machinery. This is a capability of the existing shared surfaces, not a new
destination:

- **Action Center triage:** the Fix/Decide/Do lanes on one monitor drive the
  exact resolution surface (ledger, reconciliation, receipt match, report)
  on the other; resolving an item advances the list without losing place.
- **List-drives-detail (generalized):** any master list targets a companion
  detail window — transaction journal → transaction detail, receipt inbox →
  receipt image beside its candidate transaction, Money Timeline → the
  event's source, statement lines → the ledger being reconciled.
- **Report + drill-through:** a full-screen report or dashboard on one
  monitor while "Explain this number" traces and source transactions open
  on the other, keeping the report in view while auditing provenance.
- **Operator / Ask Your Books + cited evidence:** the conversation on one
  monitor while evidence links and previewed diffs render on the other, so
  a proposed command's balanced diff is inspectable beside the request.

**MVP:**

1. Pop-out/re-dock affordance on the Action Center resolution pane, the
   transaction detail pane, and report drill-through.
2. Bidirectional selection/hover/scroll-position sync over a same-origin
   channel with no perceptible lag.
3. Closing (or crashing) a pop-out re-docks the pane into the main window
   without losing state; pop-outs reuse existing data subscriptions rather
   than duplicating polling.
4. Window arrangement remembered per user and surface so a two-monitor
   setup restores in one action.
5. Everything remains fully usable single-window — pop-out is an
   enhancement, never a requirement.

**Integration:** Consumes existing `FinancialAction`, `EvidenceRef`, and
`CalculationTrace` contracts unchanged; RBAC and book scope come from the
existing authenticated routes. No new data model.

**Checklist answers:** Improves the recurring weekly-close and
reconciliation workflows (measure: time-to-tie-out and Action Center items
resolved per session, both already tracked by Continuous Close). Emits
nothing new — it is presentation over existing actions, traces, and events,
which is why it must ship as a surface capability rather than an orphan
page. Deterministic (window/state sync only), single- and cross-book alike,
and preview/approve/undo semantics are inherited from the surfaces it hosts.

**Effort:** M.

**Delivered:** A per-surface pop-out window manager (named same-origin
windows, BroadcastChannel state sync, remembered per-surface window
geometry, poll-based close detection) backs three surfaces: transaction
detail and “Explain this number” gain pop-out affordances in their shared
modals — every host (journal, ledger, dashboard KPIs, Action Center) routes
selections to the open pop-out and re-docks the last pane state inline when
the window closes — and the Action Center adds a persisted two-window mode
that drives each action's exact resolution surface in a companion window.
Chrome-less authenticated `/popout/*` routes restore themselves on refresh;
everything remains fully usable single-window. Cross-book (family-scope)
resolution stays in the main window because it switches the shared session
book.

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

## P3 - Home Assistant Energy Integration: Bill vs. Metered Usage

**Status:** Open. Requested 2026-08-11.

**Outcome:** Every imported electric bill is cross-checked against what the
house actually metered: the utility's billed kWh beside Home Assistant's
measured consumption for the same service period, with the difference
surfaced — a meter-vs-monitor discrepancy, an estimated-read month, or a
billing error becomes visible instead of invisible.

**Environment facts (verified 2026-08-11 against the live HA instance on
truenas, container `homeassistant`, config `/mnt/docker/volumes/hass`):**

- Whole-home monitoring is an Emporia Vue 2: the energy dashboard's grid
  source is `sensor.vue2_total_daily_energy`, plus ~15 per-circuit device
  sensors (AC, dryer, furnace, garage, kitchen…) in `.storage/energy`.
  Configured flat price: $0.119/kWh.
- Long-term statistics live in the recorder's **TimescaleDB** (Postgres at
  192.168.5.21:5432/homeassistant), `statistics` + `statistics_meta`
  tables: the grid sensor has hourly rows from **2023-03-13 through today**
  (~26k rows). Unit is **Wh**, not kWh — conversion required. Period usage =
  `max(sum) − min(sum)` over the window (the `sum` column is cumulative and
  survives counter resets).
- The HA container sits on `iot_macvlan` (own IP); the API is reachable
  with a long-lived access token.

**What:**

1. **Connector** following the Fuel Tracker pattern: per-book encrypted
   connection settings (HA base URL + long-lived token, chosen grid/gas
   statistic ids), a BullMQ sync job, incremental fetch keyed on period
   start. Preferred contract: the WebSocket API's
   `recorder/statistics_during_period` command (hourly/daily sums — built
   for exactly this; REST `/api/history/period` is unsuited to multi-year
   ranges). Direct TimescaleDB read is the documented fallback, not the
   contract.
2. **Bill cross-check:** for each utility bill with a parsed service
   period, compute metered kWh over that period and show billed vs.
   metered with the delta and percent. Deviations beyond a tolerance
   (estimated reads, meter/CT drift, missing days) become Action Center
   items with the calculation trace; matched bills carry the metered figure
   as evidence.
3. **Period breakdown:** per-circuit consumption for the bill period from
   the device sensors — "the AC was 41% of this bill" — feeding the
   existing charge-breakdown UI rather than a new page.
4. **Solar scenario upgrade:** actual hourly consumption profile replaces
   the flat annual-production assumption when sizing solar.

**Checklist answers:** Improves the recurring monthly bill-review workflow
(measure: bills with a metered cross-check, and discrepancy dollars
surfaced). Emits Action Center items + evidence on existing bills — no new
surface. Reuses the utilities profile, Fuel Tracker connector pattern,
Action Center, and provenance contracts. Deterministic (sum-difference over
a period; no AI). Preview/undo inherited from the bill review queue.
Single-book. Depends on: `src/lib/resilience/` utilities section, receipt
evidence links, connections settings, BullMQ worker.

**Effort:** M.

---

## P2 - GnuCash XML Format: Full-Fidelity Round-Trip

**Status:** Implemented 2026-08-11 (three waves). Requested 2026-08-04.

**Delivered:** `docs/gnucash-xml-schema-inventory.md` — the complete gnc-v2
schema derived from the upstream libgnucash XML backend source (every element
family, attribute, encoding, omit-when-default rule, and a coverage table) —
then three implementation waves over `src/lib/gnucash-xml/`:

1. **Slots + lots.** A generic KVP slot codec (`slots.ts`: XML slot trees ↔
   typed values ↔ native `slots` rows, all value types; binary/unknown →
   `ImportSummary.skipped`) wired into act/trn/split/book/cmdty/lot/bgt
   slots while preserving the hidden/placeholder/notes column mirrors and
   budget amount frames. Real `act:lots`/`gnc:lot` parse + emit with titles
   and notes; `is_closed` derived from exact member-split sums. Fixed a live
   export bug (`split:lot` refs silently dropped — exporter/builder field
   mismatch), `cmdty:get_quotes` NaN parse, `act:non-standard-scu`,
   `recurrence:weekend_adj` both directions, and count-data completeness.
2. **Scheduled + template transactions.** Full `gnc:schedxaction` v2 and
   `gnc:template-transactions` both directions, composite/multi-recurrence
   schedules included. The importer now creates a distinct template root
   (fixing `root_template_guid` aliasing the real root; legacy books repaired
   on overwrite). Surfaced and fixed a pre-existing bug:
   `resolveTemplateSplits` couldn't read the native flat template layout, so
   desktop-created SXs resolved to zero splits in the app — it now reads
   both layouts, app layout precedent, regression-tested. Exported
   app-created templates get `sched-xaction` frames synthesized so desktop
   can execute them. `sx:deferredInstance` has no native SQL home (upstream
   drops it too) and is recorded as skipped; v1 `sx:freqspec` files are
   skipped with a clear note.
3. **Business objects.** All nine families (billterm days/proximo, taxtable +
   entries, customer, vendor, employee, job, invoice incl. posted
   txn/lot/account refs, entry with all i-*/b-* fields, order) with upstream
   encodings (owner/address sub-elements, 0/1 booleans, maybe_add omission,
   literal `cd:type` class names, business namespaces). Imports insert in
   dependency order, resolve refs only within the incoming file, record
   `gnucash_web_business_entity_ownership` in the same transaction, warn on
   dangling refs, and clear child-first on overwrite; exports scope by the
   ownership table. Bonus fix: vendor `tax_inc` was compared
   case-sensitively so desktop books showed tax-included wrong.

Round-trip fixtures (parse → build → reparse asserting zero loss) cover all
of the above; the module suite grew 13 → 78 tests. Known residual gaps, all
recorded in `ImportSummary.skipped` rather than silently dropped:
`billterm:child`/`taxtable:child` (no native column; upstream SQL drops them
too), `addr:slots` (same), `sx:deferredInstance`, v1 freqspec files, binary
KVP slots. Pre-existing and out of scope here:
`deleteOwnedBusinessEntitiesForBook` misses bill-attached entries on book
delete (flagged separately).

**Outcome:** The XML export/import path preserves as much of a GnuCash book as
the format itself can carry, so the XML file is a trustworthy interchange and
backup medium rather than a lossy subset.

**What:** Reverse engineer / read the GnuCash application source (the libgnucash
XML backend, `gnucash/libgnucash/backend/xml/` in the upstream repo, plus the
RELAX NG-ish structure implied by `gnc-v2` files) to enumerate the **entire**
scope of the XML save format, then close the gap between that and
`src/lib/gnucash-xml/`.

Current coverage (`src/lib/gnucash-xml/types.ts` / `ImportSummary`):
commodities, accounts, transactions, splits, prices, budgets. Known-missing
element families to confirm against source:

- `gnc:schedxaction` + the template-transactions sub-book (scheduled
  transactions — the app models these natively, so skipping them on
  export/import loses real data)
- `gnc:lot` and split lot references (the lot engine is now a core feature;
  XML round-trip must not sever lot links)
- KVP slots (`act:slots`, `trn:slots`, `split:slots`, book slots) — notes,
  hidden/placeholder flags, online banking IDs, reconcile info, and many
  app-relevant markers live here
- Business objects: `gnc:GncCustomer`, `GncVendor`, `GncEmployee`,
  `GncInvoice`, `GncEntry`, `GncJob`, `GncBillTerm`, `GncTaxTable`,
  `GncOrder`
- `gnc:count-data` declarations, book options, counters, recurrence
  encodings, commodity namespaces/quote sources, price source/type fields,
  and version attributes per element

**Deliverables:**

1. A written schema inventory (docs/) mapping every XML element/attribute to
   its DB representation, marked supported / unsupported / intentionally
   skipped — derived from the GnuCash source, not from sample files alone.
2. Extend parser/importer/exporter/builder to cover everything the app has a
   native model for (scheduled transactions, lots, slots, business entities).
3. For elements the app does not model, preserve-and-re-emit where feasible
   (opaque passthrough) or record them explicitly in `ImportSummary.skipped`
   — never silently drop.
4. Round-trip tests: import a desktop-authored file, export, re-import, and
   diff — including a real `gnc-v2` fixture with business and scheduled data.

**Integration:** Import gaps and skipped elements surface in the import
summary (and Action Center where a skip loses user data); pairs with the
P3 Scheduled Book Sync item, which needs the same schema knowledge.

**Depends on:** `src/lib/gnucash-xml/`, upstream GnuCash source reading.

**Effort:** L (schema inventory M; implementation of the missing families M-L).

---

## P3 - Transaction Entry: Memo in Modal + Double-Line Edit View

**Status:** Implemented 2026-08-04.

**Delivered:** Simple mode of `TransactionForm` gained a Memo field written
to both splits (matching desktop's Transfer dialog); editing a transaction
whose two memos differ seeds blank and preserves each split's own memo
untouched. Simple-mode edits now reuse split guids and preserve reconcile
state (previously regenerated). Num is a narrow check-number field beside
the date. Double-line edit view (ledger `ViewMenu` toggle, persisted):
transaction notes (new slots-backed `transaction-notes.ts`,
undefined=untouched/''=clear contract) and this-account memo editable in
place on `EditableRow`/`InlineEditRow` without resetting reconcile state.
Bonus fix: inline saves no longer blank the check number.

**What:**

1. **Memo field in the new-transaction modal.** The simple mode of
   `TransactionForm` (`src/components/TransactionForm.tsx`) captures date,
   description, num, amount, and from/to accounts, but no memo — the memo
   column exists only in the advanced splits grid. Add a memo input to simple
   mode and carry it onto the created splits so quick entry doesn't force a
   trip through advanced mode.
2. **Shrink the Num field.** The Num input ("Check #, reference, etc.") is
   currently full-width in the modal, which makes it read as the memo/comments
   field. Match GnuCash desktop's register proportions: Num is a narrow field
   (check-number width) beside the date, and the wide field is the
   description/memo. Rarely used, so it should recede visually.
3. **Double-line view for edit mode.** Mirror GnuCash desktop's double-line
   register: each transaction row expands to a second line exposing the
   transaction-level notes and the per-split memo, editable in place. Apply
   this as a view layer on the edit surfaces (ledger inline edit /
   `EditableSplitRows`) so memos are visible and editable without opening the
   full splits editor. Respect the ledger inline-save rule already shipped:
   memo/description edits must not reset reconcile state.

**Effort:** S for the modal memo field; M for the double-line edit view.

---

## P2 - Transaction Comments and Change History (Zoho Books-style)

**Status:** Proposed 2026-08-19.

**Why:** Zoho Books shows, on every transaction, a threaded comment stream
interleaved with the transaction's change history — who changed what, when,
and the discussion around it. Today a GnuCash Web transaction carries only
free-text notes/memos (`transaction-notes.ts`, split memos), which are a
single mutable field with no author, no time, and no thread. The
`gnucash_web_audit` table already records `old_values`/`new_values` per
entity mutation with a `user_id`, but nothing surfaces it per transaction and
there is no place to leave a comment *about* a transaction ("asked vendor for
corrected invoice", "this is the reimbursement for the May trip") without
overwriting the bookkeeping note.

**What:**

1. **Per-transaction history panel.** A "History" tab/section on the
   transaction detail (ledger row expand, edit modal, journal) that renders
   the `gnucash_web_audit` rows for that transaction guid AND its splits as a
   human-readable timeline: "Justin changed amount $120.00 → $102.00 and
   account Expenses:Food → Expenses:Groceries (2026-08-19 14:02)". Diff
   old/new JSON into field-level lines; resolve account guids to paths and
   user ids to display names. Include create, edit, reconcile-state change,
   lot assignment, scheduled-transaction execution, SimpleFIN import/update
   and undo events. Where an edit came from automation (sync, scrub, rule),
   attribute it to that actor so the trail reads honestly.
2. **Threaded comments.** New book-scoped table
   `gnucash_web_transaction_comments (id, txn_guid, book_root_guid, user_id,
   parent_id NULL, body TEXT, created_at, edited_at, deleted_at)`. Comments
   are authored, timestamped, editable by their author, soft-deleted, and
   support one level of reply (a thread) plus @-mention of other book
   members. They are NOT the GnuCash note: the note stays the bookkeeping
   description that round-trips to desktop/XML; comments are app-side
   discussion that never touches the GnuCash schema.
3. **One interleaved stream.** History events and comments render in a single
   chronological feed per transaction, the way Zoho presents it — a comment
   can sit right under the change it is discussing. Comments can optionally
   reference a specific audit event (`audit_id`) so "why did this change?"
   has a direct answer.
4. **Surfacing.** A small comment-count badge on ledger/journal rows; an
   "unresolved comments" Action Center source (comment threads can be marked
   resolved); notifications (existing ntfy/in-app channel) on @-mention or
   reply. Comments are searchable from the transaction search box.
5. **Provenance tie-in.** Any report figure that drills to a transaction
   shows its comment count, so a reviewer can read the discussion from the
   provenance drawer without leaving the report.

**Scope notes:** Book-scoped and RBAC-gated (viewers read, editors comment,
only authors edit/delete their own; admins can delete). Comments are exported
with the book (JSON) and included in the document-evidence model as
`EvidenceRef { kind: 'comment' }`. Out of scope for v1: comments on
accounts/invoices/documents (same table shape can extend later via an
`entity_type` column — design it in from the start, but only wire
transactions).

**Effort:** M — the audit data already exists; the work is the diff renderer,
the comments table + API + RBAC, and the UI feed.

---

## P3 - Accounts API: Remove Book Name from `fullname`

**Status:** Implemented 2026-07-26.

Return `Assets:Checking` rather than
`Crawford Personal Finances:Assets:Checking`, with `book_name` as a separate
field. Update both flat-account and hierarchy responses and remove redundant
client-side stripping.

**Effort:** XS.

**Delivered:** Flat and hierarchical account responses now expose book-relative
`fullname` values and a separate `book_name`. Account pickers, command search,
quick switching, and payslip account display consume the normalized API contract
without client-side root stripping.

---

## P4 - Canonical Document Platform Follow-Ups

**Status:** Implemented 2026-08-03.

Harden the shared document store now used by feature packs without creating
another document silo:

1. Make the `LinkedDocumentsPanel` picker use search-backed pagination so every
   authorized document remains discoverable beyond the newest 100 results.
2. Resolve linked documents in batches, replacing per-record lookups that cause
   N+1 query amplification on list and report surfaces.
3. Add an OCR fallback for scanned and image-only PDFs when ordinary text
   extraction produces no usable content.
4. When a Family Office document result belongs to another authorized book,
   switch the active book before opening its source so navigation never lands in
   the wrong book context.

**Acceptance:** Picker search and paging return authorized results without a
100-document ceiling; linked-document lists use a bounded number of queries;
scanned-PDF content enters the existing parse/search pipeline with explicit
failure state; and cross-book document results open in the owning authorized
book while preserving RBAC boundaries.

**Depends on:** Canonical document store and typed links, document parsing and
search, Family Office authorization graph, and active-book session switching.

**Effort:** M.

**Delivered:** The picker is search-backed and paged (25 rows, debounced, one
in-flight `AbortController`) against `listDocumentsPage`, so nothing is stranded
behind the old 100-row ceiling; the selected document is pinned into the option
list so a later search cannot silently drop it.

The N+1 was larger than reported: `listLinkedDocuments` itself resolved one
document per link. It now issues 2 queries regardless of link count (1 when
there are none) via `getDocumentsByIds`, and the two per-record call sites
(claims package, farm certificate obligations) batch to 1 each through
`getDocumentsBySources`. Every batch query carries `book_guid` explicitly — the
optimization did not widen scope. A missing or foreign document still throws
rather than being skipped, so a cross-book reference stays *refused* instead of
quietly becoming invisible.

Scanned and image-only PDFs get OCR through an injected hook, so
`pdf-text-extract.ts` keeps its no-heavy-deps property (the Dockerfile guard
exists to protect exactly that) and the two duplicate `extractTextFromPdf`
implementations collapsed into one. A PDF with no text layer and no working OCR
now lands in an explicit `failed` state with a specific reason, instead of being
recorded as a completed index over empty text.

Family Office global-document results are the only genuinely cross-book
navigation (`/search` is already active-book scoped and now says so); they route
through `switchBook`, render as buttons so a middle-click cannot bypass the
switch, and label the owning book before and during the switch. `switchBook`
also stopped swallowing a non-OK response — a revoked grant used to make the
click do nothing at all on both this surface and the Action Center.

---

## P4 - Document Vault: Multi-File Upload with Post-Upload Detailing

**Status:** Implemented 2026-08-13 (`4474954`). Staged multi-file drop zone
with per-file remove and batch cancel, sequential upload with per-file
progress/failure, and a post-upload detailing pass with apply-type-to-all and
an untyped counter.

**Outcome:** A stack of documents (e.g. the escrow docs from a mortgage — a
dozen PDFs at once) goes into the vault in one action instead of one
upload-form round-trip per file. Metadata entry happens after the bytes are
up, not before.

**What:** Extend the vault at `/business/documents` (household books reach it
as "Household Documents" under Planning → Home):

1. **Bulk upload:** the existing drag-and-drop zone and file picker accept
   multiple files (`multiple`/`dataTransfer.files`), staged as a reviewable
   list *before* anything is sent — each staged file has a remove button,
   and the whole batch can be cancelled, so a stray drop never commits.
   Upload then sends them all — sequential or small-batch parallel
   `POST /api/business/documents` calls is fine; no new endpoint
   required — with per-file progress and per-file failure reporting (one
   oversized file must not abort the rest).
2. **Post-upload detailing pass:** after the batch lands, the just-uploaded
   files appear in an editing list where doc type, expiry, title, and notes
   can be set per file (the existing `PUT /api/business/documents/[id]`
   already supports this). Files default to title-from-filename and type
   `other`, exactly like today's single upload, so abandoning the detailing
   pass leaves valid records rather than half-created ones.
3. Reasonable conveniences in the detailing pass: apply-to-all for doc type,
   tab-through editing, and a clear "n of m still untyped" indicator.

**Checklist answers:** UX capability on an existing surface — no new page,
model, or endpoint; records remain plain entity documents feeding the
existing expiry reminders, renewals, and document search. Deterministic;
single-book; RBAC unchanged (`edit` role, same 10MB/type limits per file).

**Depends on:** Entity documents service and vault page, existing
create/update endpoints.

**Effort:** S.

---

## P3 - Tax Records Archive: By-Year Grouping and AI Form Classification

**Status:** Implemented 2026-08-13 (`4474954`). `tax_year`/`tax_form`/`issuer`
columns, tax-form subtypes, by-year grouped view with a deterministic
missing-vs-prior-year checklist, AI classification behind a review-before-accept
suggestions endpoint, in-season Action Center items, and source forms bundled
into the Year-End Tax Package ZIP.

**Outcome:** Years of accumulated tax records — W-2s, 1099-INT/DIV/B/R,
1098s, 5498s, K-1s, and the filed returns themselves, from every
institution — live in the vault grouped by tax year. Uploading a stack of
them is a bulk drop, not a filing chore: the AI reads each document and
proposes its form type, tax year, and issuing institution for one-click
confirmation.

**What:** Builds on the multi-file upload item above; same vault, no new
document silo:

1. **Tax-year metadata:** add an optional `tax_year` to entity documents
   and tax-form subtypes under the existing `tax` doc type (W-2, 1099-INT,
   1099-DIV, 1099-B, 1099-R, 1099-NEC, 1098, 5498, K-1, filed return,
   notice, other). Issuer reuses the existing parties/notes fields rather
   than a new institution model.
2. **By-year view:** the vault gains a tax-records grouping — year
   sections (2019, 2020, …) with form-type and issuer visible per row, so
   "everything for 2022" is one glance and one download.
3. **AI classification, review-before-accept:** extend the existing
   generic vault extraction (`entity-extraction.ts` already produces
   document class, dates, parties, and reference numbers, and deliberately
   writes no business fields) with a tax-form pass that *suggests* form
   type, tax year, and issuer. Suggestions are confirmed in the bulk
   post-upload detailing pass — accept-all when the batch is one year's
   folder — never silently written. Applies to already-uploaded `tax`
   documents too, via the existing re-extraction machinery.
4. **Year completeness signal:** deterministic diff against prior years —
   an issuer that sent a 1099 last year but is missing this year after
   January becomes a gentle checklist entry on the year group (and, in
   season, an Action Center item).
5. **Tax-surface links:** the Year-End Tax Package and accountant
   workspace can include the year's archived source forms; the tax
   estimator's contribution/interest figures can cite the matching form as
   evidence where amounts line up.

**Checklist answers:** Feeds existing shared surfaces (Action Center for
missing-form signals, tax package/accountant exports, document search) —
no orphan page. Deterministic grouping and completeness math; AI only
suggests classification from document text, with explicit user
confirmation (product rule: deterministic before generative).
Single-book; RBAC and storage limits unchanged.

**Depends on:** Multi-file upload item above, entity documents service,
canonical document extraction pipeline (`src/lib/documents/`), Year-End
Tax Package, Action Center.

**Effort:** M.

---

## P3 - Document Vault: Paperless-ngx-style Preview Cards and Grouped Table

**Status:** Open. Requested 2026-08-13.

**Outcome:** The vault reads like paperless-ngx: you recognize a document by
*looking* at it, not by parsing a filename in a text row. A thumbnail grid is
the browse surface; a real data table is the work surface; category grouping
is the default organization in both.

**What:** Rework the vault at `/business/documents` (household books reach it
as "Household Documents" under Planning → Home) along three axes.

1. **Preview cards (the new capability).** A card grid where each document
   renders its **first page as a thumbnail**, with title, category badge,
   date, and the existing actions. Today the only visual access is
   `DocumentPreviewModal` — open one document at a time, full size. Nothing in
   the repo generates thumbnails (`grep -rn thumbnail src/` → zero hits), so
   this is the item's real cost:
   - Render page 1 to a raster on upload, as a queue job alongside the
     existing `src/lib/queue/jobs/extract-entity-document.ts` extraction pass,
     so uploads stay fast and a render failure degrades to a type icon rather
     than failing the upload.
   - Backfill existing documents through the same job; a document with no
     thumbnail yet must render as a placeholder card, never a broken image.
   - Store thumbnails beside the source bytes under the same RBAC and book
     scope, and serve them from a dedicated route — **not** by streaming the
     full original and scaling client-side, which would send an entire 10MB
     PDF to draw a 200px card.
   - Respect `src/lib/document-preview.ts`. Its safelist (pdf, png, jpeg, gif,
     webp) deliberately excludes `text/html` and `image/svg+xml` as a
     stored-XSS vector; thumbnails must not become a back door that renders an
     excluded type. Serve rasterized output only, with the same
     `X-Content-Type-Options: nosniff` posture.
   - Server-side PDF rasterization is a known parser-exposure surface: run it
     in the worker (never in a request handler), bound page count, pixel
     dimensions and time, and treat a malformed file as a failed render rather
     than an exception that kills the job.

2. **List view → TanStack Table, grouped by category.** The list already
   groups by `doc_type` (`page.tsx:510-527`), but it is hand-rolled: a
   `typeOptions.map` with a `filter` per group and a `__legacy__` bucket for
   uncontextual types, with no sorting, no column model, and no persistence.
   Replace it with `@tanstack/react-table` using the real grouping model —
   already a dependency at `^8.21.3` and already the pattern in
   `AccountLedger`, `AccountHierarchy`, `src/components/ledger/columns.tsx`,
   commodities, and payslips, so this is consistency work, not a new library.
   Columns: title, category, issuer, issued, expires, size, type. Sortable,
   with expand/collapse per group and a per-group count.
   - **Grouping key should be a control, not a constant.** Category is the
     right *default*, but the tax archive already groups by year via
     `groupTaxRecordsByYear`, and that view must not regress — expose grouping
     as category | tax year | issuer | none, defaulting to category, with the
     tax subtree defaulting to year. Land the generic grouping first and fold
     the tax view into it only if it comes out cleaner; a worse tax archive in
     exchange for architectural symmetry is a bad trade.
   - Persist view mode, grouping key, sort, and expansion to localStorage, the
     way `AccountHierarchy` already does.

3. **Card/table toggle** on one shared filtered dataset, so search, category
   filter, and grouping mean the same thing in both views and switching never
   changes *which* documents you're looking at.

**Notes:**
- `page.tsx` is **1,187 lines** after the multi-file upload and tax archive
  work. Extract the browse surface into components under
  `src/components/documents/` as part of this; do not grow the page further.
- `@tanstack/react-virtual` is a dependency with **zero imports** repo-wide —
  the open ASI-6-006 item ("wire up or remove"). A thumbnail grid over a
  multi-year archive is the natural place to either use it or delete it.
  Decide there rather than leaving it dangling.
- Thumbnails are the one genuinely expensive piece here. If it needs to ship
  in stages, the table conversion (2) stands on its own and delivers value
  without any of the rendering pipeline.

**Checklist answers:** Improves the recurring "find the right document"
workflow, which is currently filename-scanning. Emits no new Action, Timeline,
or Plan input — it is a browse surface over existing records and deliberately
does not introduce another document model. Reuses the entity documents service,
the existing list/download endpoints, the extraction queue, and the established
TanStack Table pattern. Deterministic (grouping/sorting are pure functions over
the fetched rows; thumbnail rendering is a testable pure transform from bytes to
raster). No preview/approval/undo surface — read-only presentation, no mutation.
Single-book; no currency involvement. Success measure: time to locate a known
document, and the share of vault documents with a usable thumbnail.

**Depends on:** Entity documents service and vault page, document preview
contract (`src/lib/document-preview.ts`), extraction queue job, object storage.

**Effort:** M (table + cards), plus M for the thumbnail pipeline.

---

## P3 - Document Vault: Auto-Tagging, In-Vault Text Search, and (v2/v3) RAG

**Status:** Open. Requested 2026-08-13.

**Outcome:** Paperless-ngx's organizing model — documents carry meaningful
tags applied automatically, and you can find any document by something it
*says*, not just by what it's called. Semantic retrieval across document text
is explicitly deferred to v2/v3.

**Start here — most of this already exists and is simply not surfaced.**
Verified 2026-08-13 before writing this item:

- **Vault text is already extracted and already full-text indexed.**
  `runEntityDocumentExtraction` (`src/lib/documents/entity-extraction.ts:103-115`)
  upserts a canonical `gnucash_web_documents` row with
  `sourceKind: 'entity_document'` carrying `extracted_text`, and db-init
  maintains a generated `search_tsvector` + GIN `idx_documents_search_fts`.
  `doc-search.ts:305-316` searches that table with
  `source_kind NOT IN ('receipt','statement_batch','payslip')` — which
  **includes** vault documents. So `GET /api/search/documents?q=` already
  searches vault text today.
- **The vault UI has no search box at all** (`grep -n "search" page.tsx` →
  zero hits). The capability exists and is unreachable from the surface that
  needs it most.
- **Generic AI classification already exists.** The extraction pass emits
  `suggestionKind` values `generic_document`, `insurance_policy`,
  `estate_document`, and `tax_record`, each parsed and bounded before
  persisting. But the vault UI consumes **only** `tax_record`
  (`page.tsx:265`), so every non-tax document already has suggestions
  computed and thrown away.
- **A book-scoped tag model already exists** — `gnucash_web_tags` at
  `schema.prisma:955`, with `gnucash_web_transaction_tags` and
  `gnucash_web_account_tags` join tables and a `(book_guid, name)` unique.
  Documents have no join table, and `doc_type` is a single VARCHAR, so a
  document today has exactly one category and no tags.

### v1 — surface what is already built

1. **Search in the vault.** A search box on the vault page over the existing
   `/api/search/documents` results, filtered to `entity_document`, with a
   matched-text snippet on each hit. Fold it into the same filtered dataset
   feeding the card and table views from the item above, so search, category
   filter, and grouping compose instead of fighting.
2. **Consume the generic suggestions for every document type**, not just tax.
   The polling, review-before-accept, and apply flow already exist in the tax
   detailing pass (`page.tsx:253-266,435-446`) — generalize it rather than
   writing a second one. Keep the accept gate: suggestions stay advisory and
   are applied through the ordinary `PUT`, per the deterministic-before-
   generative product rule.
3. **Multi-tag documents by reusing `gnucash_web_tags`.** Add a
   `gnucash_web_document_tags` join table following the exact shape of the
   transaction/account tag tables. Do **not** invent a second tag vocabulary —
   a tag should mean the same thing on a transaction and on the document that
   evidences it, which is also what makes tags useful for linking evidence
   later. `doc_type` stays as the single primary category driving grouping;
   tags are additive.
4. **Auto-apply rules, deterministic first.** Paperless's real leverage is
   that tagging becomes automatic. Ship rule-based matching (issuer/filename/
   text contains → tag) before leaning on the model: rules are inspectable,
   testable, and reproducible, and they give the AI pass something to be
   checked against. AI-suggested tags land as suggestions, never as silent
   writes.

**v1 checklist answers:** Improves the recurring find-and-file workflow.
Emits no new Action or Timeline event; it strengthens evidence linkage, which
the provenance rule already depends on. Reuses the entity documents service,
the canonical document store and its FTS index, the existing extraction/
suggestion pipeline, and the existing tag model — no new engine. Deterministic
where it matters: rule matching and search ranking are pure and testable, and
the AI path is advisory with an explicit accept step. Preview/approve: every
suggested value is reviewed before it is written; undo is the ordinary
document edit. Single-book (all four tables are book-scoped); no currency
involvement. Success measure: share of documents with at least one tag applied
without manual entry, and whether search-by-content actually gets used.

**v1 effort:** S–M. Most of the cost is UI; the pipeline is built.

### v2/v3 — RAG store (deferred, do not start with this)

Chunk + embed vault document text for semantic retrieval and grounded
question-answering across the archive ("what's my deductible on the barn
policy?"), where Postgres FTS's exact-token matching falls short.

Deferred deliberately: auto-tagging plus working full-text search resolves
most of the actual retrieval need at a fraction of the cost and operational
surface, and it is the right thing to measure *before* deciding an embedding
store is warranted. Recorded now only so v1 doesn't foreclose it.

When it is picked up:
- Chunking and embedding belong in the existing extraction worker, keyed off
  `gnucash_web_documents.extracted_text`, so there is still exactly one
  canonical text of record. Do not create a second document store.
- Prefer `pgvector` in the existing Postgres over a new external service —
  self-hosted is the product's whole posture, and a separate vector database
  is a second thing to back up, secure, and keep book-scoped.
- **Book scoping and RBAC must hold at retrieval time.** An embedding index
  that ignores `book_guid` silently leaks documents across books; this is the
  single largest correctness risk in the feature.
- Retrieval must be hybrid (FTS + vector) and must **cite the source document
  and page**. Per the product rules, generated text may explain and summarize
  but never invent figures — any dollar amount in an answer has to trace to a
  document or it does not ship.
- Re-embedding on document change, and embedding cost/latency per upload, are
  the operational unknowns to size first.

**Depends on:** Entity documents service and vault page, canonical document
store and its FTS index, extraction/suggestion pipeline, `gnucash_web_tags`.
The vault browse rework above is the natural surface for all of it.

**Effort:** S–M for v1. RAG is L and unscoped by design.

---

## P4 - Receipt AI Re-Extraction Batch Job

**Status:** Implemented 2026-07-26.

Add “Re-extract all” in AI settings for receipts still using regex extraction.
Queue jobs through BullMQ, expose progress through the existing job-progress
system, and avoid reprocessing already-AI-extracted receipts unless explicitly
requested.

**Effort:** S.

**Delivered:** Receipt administrators can queue AI re-extraction for legacy
regex and missing extractions from the receipt gallery. The book-scoped BullMQ
job reports live progress, preserves review metadata, continues past individual
failures, and protects already-AI-extracted receipts by default.

---

## P4 - Compact Sidebar Menu Density

**Status:** Implemented 2026-08-01.

Reduce the vertical spacing of sidebar navigation items — there is currently too
much room between menu items. Desktop nav items in `src/components/Layout.tsx`
use `py-3` (12px vertical padding) plus `space-y-1` between items; tighten to
roughly `py-2`/`space-y-0.5` so more of the navigation fits on screen without
scrolling. Keep sub-item rows at the 44px minimum touch target on mobile, and
stay within the DESIGN.md "comfortable" density and 4px spacing scale.

**Effort:** XS.

**Delivered:** Desktop sidebar items tightened to 8px vertical padding with
2px gaps and compact sub-item rows; the mobile drawer keeps its 44px touch
targets.

---

## P2 - Utilities & Solar: Bill Review Workflow Revamp

**Status:** Implemented 2026-08-11. Raised 2026-08-06 after the first real use
of bill capture, once drag-and-drop upload and OCR extraction started working.

**Delivered:** The utilities surface moved to its own
`src/components/resilience/UtilitiesPage.tsx` and became a staged review
queue. Import now filters the suggestion against the *edit buffer* (not just
saved bills), so the row leaves the queue the instant it is imported, lands
highlighted + "staged" in the bills table, and raises a toast that states the
Import→Save relationship; the SaveBar counts staged bills and gained
Discard. Bulk review: per-row checkboxes, "select all without warnings", and
"Import selected (n)". Duplicate handling in two layers: identical parses
from the same PDF uploaded twice are collapsed server-side
(`dedupeUtilityBillSuggestions`, keyed on type + service period/date + usage
+ total), and a suggestion matching an already-imported bill from a
*different* receipt is flagged "Possible duplicate" and excluded from bulk
select (still importable deliberately). The card stack became a sortable,
type-filterable table (date/provider/usage/$-per-unit/total, mono
right-aligned per DESIGN.md) with per-row expand-to-edit, and every
receipt-backed row and suggestion links to its source receipt
(`/api/receipts/{id}`). Undo staged imports returns them to the queue as a
unit. Also fixed in passing: the Action Center's `?tab=solar` deep link was
ignored (tab state now honors the query). Covered by
`src/components/resilience/__tests__/UtilitiesPage.test.tsx` and new
duplicate-key tests in `p3-core.test.ts`.

**Outcome:** Reviewing a batch of uploaded bills feels like a review queue —
each decision confirmed, reversible, and possible in bulk — instead of a form
that silently accumulates state until a separate Save.

**The problem, as observed on a real 24-bill batch:**

Extraction now works, which exposed that the surface around it does not. In
`src/components/resilience/P3FeaturePages.tsx`:

1. **Import gives no feedback.** `addBill()` calls `state.change()`, which only
   mutates the local edit buffer and sets `dirty` (`useSection`, ~:73). Nothing
   about the clicked row changes: suggestions render from `state.response`, so
   the row stays exactly where it was, and the imported bill is appended to a
   list sorted by date descending — it can land anywhere, including off-screen.
   The click looks like it did nothing. There is a `SaveBar`, but the
   relationship between "Import" and "Save" is never stated.
2. **No bulk action.** 24 bills is 24 clicks and one Save, with no
   select-all, no range select, and no "import everything that parsed cleanly".
3. **Duplicate uploads produce duplicate suggestions.** The same PDF uploaded
   twice yields two identical rows (receipts #4 and #5 in the current book);
   nothing collapses them or flags the collision.
4. **Imported bills render as a stack of full edit forms.** Each is a
   `RecordCard` of five inputs. At 24 bills that is 120 inputs on one page,
   with no table view, sort, filter, or pagination — and no way to scan the
   series that the page's own analysis is built on.
5. **Evidence is not reachable from the row.** A suggestion carries a
   `receiptId`, but there is no link to the source receipt image, so a figure
   cannot be checked against the bill it came from without leaving the page.
6. **Import is not reversible as a unit.** Undo means finding the row and
   removing it by hand.

**Approach:** Review adversarially before designing — the list above is what
one pass over the code surfaced, not a complete account, and the workflow
should be walked end to end with a real batch (upload → OCR → review →
import → save → analysis) looking for other dead ends. `/design-review` is the
intended vehicle; DESIGN.md governs the visual result.

**Checklist answers:** Improves a recurring workflow (monthly bill capture),
reusing the existing suggestion loader, receipt/OCR pipeline, and utility
analysis engine — it emits no new Action, event, or trace and adds no
destination, which is the point: it is workflow repair on a surface that
already exists. Deterministic (no new calculation; parsing is already covered
by `p3-core.test.ts`). Preview/approve/undo is exactly what is missing and what
this adds. Single-book, single-currency, unchanged. Measurable outcome: clicks
and elapsed time to review a month's bills, and whether imported bills match
their source statements.

**Depends on:** `src/components/resilience/P3FeaturePages.tsx`,
`loadUtilityBillSuggestions()` in `src/lib/resilience/service.ts`,
`parseUtilityBillText()` in `src/lib/resilience/p3-core.ts`.

**Effort:** M.

---

# Correctness and reliability backlog

## P1 - Deploy Pipeline: Pushes Silently Never Reached Production

**Status:** Implemented 2026-08-12. Diagnosed 2026-08-11 when the Schedule AI
deploy silently did not reach prod.

**Correction to the original entry:** the first diagnosis ("the webhook passes
no force flag, so image-only pushes are skipped") was **wrong**. Reading the
full Dockhand deploy log showed the webhook *did* detect all 32 changed files,
logged `Will force recreate: true`, and started
`docker compose … up -d --force-recreate`. The log then simply stops — no
completion, no error.

**Actual root cause:** Dockhand runs the deploy **inside the HTTP request**.
The fresh clone plus image pull and recreate exceeds Cloudflare's 100-second
edge limit, so the connection dropped (observed 524) and killed the deploy
mid-flight. The workflow's `curl --retry` then fired a second request, which
found the commit already synced and returned
`{"success":true,"skipped":true}` — a green build over an untouched
production. Worse, the killed deploy had already recorded the commit as
synced, so Dockhand's own scheduled sync would never retry it: every
`git_stack_sync` execution in the database is `skipped`, meaning the reliable
path had *never once* run. The webhook was not merely unreliable; it was
actively consuming the signal the scheduler needed.

**Delivered:** the request-scoped trigger is gone. `deploy.yml` now advances a
**`deploy` branch** to the built commit *after* the image is in GHCR, and
Dockhand watches that branch on a five-minute schedule. Ordering and execution
are both fixed: the branch cannot point at a commit whose image does not exist
(a `main`-watching trigger would race the build, deploy the previous image, and
mark the commit done), and the deploy runs in Dockhand's background scheduler
with no request to drop. The image now bakes in `APP_REVISION`, `/api/health`
reports it, and the workflow polls that public endpoint until it matches the
pushed commit — failing the build with the manual fallback command if
production has not caught up in 15 minutes. Dockhand config changed on the NAS:
repo branch `main` → `deploy`, schedule `daily`/`0 3 * * *` → `custom`/
`*/5 * * * *` (DB backed up first). Flow and rationale are documented in
[docs/deployment-rollback.md](docs/deployment-rollback.md).

**Known residual:** a deploy that fails after Dockhand records the commit will
not be retried automatically. The verification step makes that loud, and the
manual command in the runbook resolves it. A digest-triggered deploy would be
self-healing but Dockhand's container auto-update is not compose-aware
(verified), so it would detach containers from the stack.

**Effort:** S-M (actual: M).

---

## P4 - Book Deletion Orphaned Business Child Rows

**Status:** Implemented 2026-08-12. Found 2026-08-11 during the XML
business-object work.

`deleteOwnedBusinessEntitiesForBook()` deleted entries reached through
invoices but not entries attached via `entries.bill` (vendor-bill line items),
so deleting a book with vendor bills orphaned those rows. A **second gap** was
found in the same function while fixing it: `taxtable_entries` were never
deleted either. Both now sweep child-first, mirroring the XML importer's
overwrite-clearing path, with tests that pin statement *order* rather than
mere presence.

Worth knowing beyond this fix: the native GnuCash business tables carry **zero
foreign-key constraints** in this database (verified against the live schema),
so nothing cascades — any future teardown or import path must sequence
children manually; there is no database-level backstop.

**Effort:** S.

---

## P1 - Book-Scope the Native Business Entities

**Status:** Implemented 2026-08-03. Raised by the audit the same day (finding
S5) and deferred out of the first remediation pass; completed immediately after.

Customers, vendors, employees, invoices, jobs, billterms, and taxtables are
native GnuCash tables with no `book_guid` column, and the app never added one.
`contactWhere()` (`src/lib/services/business.service.ts:367`) filters on
`active` and `search` only, and `getCustomer(guid)` is a bare `findUnique`, so
`GET /api/business/customers` and `/api/business/invoices` return every book's
rows. With `edit`, `PUT`/`DELETE` on another book's invoice succeeds. The header
comment in `customers/route.ts:3-5` acknowledges a "single-business-database
assumption" that the rest of the product outgrew.

**Why it was deferred rather than rushed:** the fix is an ownership side-table
plus threading `bookGuid` through 30 service functions, 41 call sites, and 73
route files — and a partial rollout is worse than none, because entities would
appear in some surfaces and vanish from others. It was not safe to land in the
same change as the rest of the audit remediation.

**Why it is not currently exploitable:** production has one user account and
zero business entities (verified 2026-08-03); dev has six, all test data. The
exposure is latent and becomes real the moment a second user or a real business
book exists.

**Approach:** mirror `src/lib/budget-ownership.ts` — a
`gnucash_web_business_entity_ownership` table keyed by (entity_type,
entity_guid) with "missing == foreign" semantics, created in `db-init.ts`
alongside the other app tables. Backfill by deriving each invoice's book from
`post_acc` -> account -> root -> book, then attributing its customer/vendor/job;
entities with no derivable link need an explicit operator choice, so surface
them rather than guessing. Ship the backfill and the read filters together.

**Acceptance:** every business list and single-entity read is filtered by the
caller's authorized book; writes verify book ownership before mutating; a
backfill assigns every pre-existing entity or reports it as unattributed; and a
test asserts that a user with a role on only one book sees no entity from
another.

**Effort:** M-L.

**Delivered:** `gnucash_web_business_entity_ownership` (entity_type,
entity_guid, book_guid) with an immutability trigger, created and backfilled in
`db-init.ts`, plus `src/lib/business/entity-ownership.ts`. Semantics match
`budget-ownership.ts`: missing ownership means foreign, so an unattributed row
is invisible to every book rather than visible to all of them.

`bookGuid` is a required positional first parameter on every customer, vendor,
job, employee, invoice, voucher, billterm, and tax-table service function — the
compiler therefore enumerates missed call sites instead of letting one leak.
Lists filter by the owned-guid set and short-circuit to `[]` rather than falling
through unfiltered; single-entity reads return null when foreign; creates record
ownership inside the same transaction as the insert; cross-entity references
(an invoice's customer, a job's owner, a bill term) must resolve inside the same
book. Non-request callers derive the book from the record itself — the Stripe
webhook from the invoice's own ownership row, recurring invoices from the stored
definition, the public payment token from the invoice it resolves to.

The backfill derives ownership only from unambiguous links (posted invoice ->
post_acc -> account -> book, employee -> ccard_guid, owners from unanimous
invoices, unposted invoices and orders from their owner, bill terms and tax
tables from referencing entities) and adopts leftovers only in a single-book
database; `reportUnattributedBusinessEntities()` names anything it could not
place. Book deletion removes the native entities child-first via
`deleteOwnedBusinessEntitiesForBook()` before transactions and accounts.

Closed several leaks beyond the CRUD surface: bill capture matched vendor names
across all books, time tracking validated customers and jobs by mere existence,
inventory fulfilment shipped against foreign posted invoices, reimbursement
approval adopted any voucher with a matching billing id, and the Action Center
and Money Timeline joined `employees` unconstrained.

---

## P4 - Ledger Inline Save Drops Memos and Reconcile State

**Status:** Implemented 2026-08-03. Found while fixing the inline-edit quantity
corruption.

`handleInlineSave` in `src/components/AccountLedger.tsx` rebuilds splits from
its payload, so every inline save discards split memos and resets the
counter-account's `reconcile_state` to `'n'`. A user correcting a typo silently
un-reconciles the other side of the transaction. Pre-existing and independent of
the quantity fix that shipped alongside it; it touches reconciliation semantics,
so it wants its own change and its own test.

**Effort:** S.

**Delivered:** Inline save carries each split's `memo`, `reconcile_state` and
`guid` through the payload (the guid matters — the PUT handler keys `action`,
`lot_guid` and `reconcile_date` off it, so a preserved `'y'` without it came
back with a null reconcile date). The rule: **a split keeps its stored
reconcile state only while its own amount and account are untouched.** A
description, date or memo edit preserves both sides; an amount edit resets both
to `'n'`, including the account's own split, because an edited amount no longer
agrees with the statement it was reconciled against and leaving it reconciled
silently corrupts the reconciled balance. Applied to `EditableSplitRows` too.

---

## P4 - Semantic Color Token Pass

**Status:** Implemented 2026-08-03.

DESIGN.md defines the palette as semantic tokens (`--positive`, `--negative`,
`--warning`, `--primary`, `--foreground`), but several components still use raw
Tailwind palette classes, so they do not follow the light/dark themes and drift
from the design system.

The 2026-08-03 audit measured the split: 429 semantic-token usages against 314
raw-palette usages for the same semantics, across 624 lines in 132 files. The
raw values are hardcoded *dark*-theme colors, so they degrade in light theme.

Already retokenized on 2026-08-03: `src/components/ui/Toast.tsx` (the shared
design-system component was the worst offender — it bypassed tokens entirely and
hand-rolled `dark:` pairs) and `src/components/ledger/LotViewer.tsx`.

Remaining offenders:

- `src/components/AccountHierarchy.tsx` — `bg-amber-500/10`, `text-amber-400`
- `src/app/(main)/scheduled-transactions/page.tsx` — `bg-gray-600/50`, `amber-*`

Sweep for raw palette classes (`emerald-`, `rose-`, `amber-`, `gray-`, `white`)
and map each to its semantic equivalent. Presentation only. Note there is no
longer a sanctioned exception: `ThemeToggle.tsx`, which used to hold one, was
deleted on 2026-08-03 as dead code (theme switching lives in
`src/contexts/ThemeContext.tsx`).

**Effort:** S.

**Delivered:** 545 raw-palette lines converted across 121 files, every emitted
utility checked against `@theme inline`. The authors' two-palette split is
preserved (`emerald`/`rose` -> positive/negative for financial gain and loss,
`green`/`red` -> success/error for status and destructive UI).

Deliberate exceptions, each now carrying a one-line comment: `TagChip.tsx`,
`LotBadge.tsx` and `AccountTypeFilter.tsx` use categorical palettes where the
hue *is* the datum (tag identity, lot index, account type) and the design system
has no categorical scale — tokenizing would render distinct categories in
identical colors. Also left raw: text over a fixed chart color or a photo scrim,
the light-only swagger-ui docs page, and `print:` overrides.

Separately fixed a real defect this surfaced: `text-foreground-tertiary` was
used 74 times and `bg-`/`text-accent-primary` 4 times, and **neither token
exists** — DESIGN.md defines exactly three foreground steps. Those elements were
silently inheriting their color. Confirmed in the browser before and after:
`text-foreground-tertiary` computed to `rgb(226,232,240)`, identical to the
inherited body color, while `text-foreground-muted` correctly resolves to
`#64748b`. All 78 now use defined tokens.

---

## P4 - Test Suite Flakiness

**Status:** Implemented 2026-08-03.

Two suites fail intermittently under parallel load and pass in isolation, which
produces false alarms on every full run and erodes trust in the suite:

- `src/lib/__tests__/pdf-text-extract.test.ts` — "extracts real PDF text
  repeatedly when PDF.js remains external" times out at ~5s; passes alone in
  about 1s. Observed failing at least three times on 2026-08-01/02. Hoist the
  expensive PDF parse out of the timed path or give it an explicit, commented
  timeout rather than raising limits blindly.
- `src/app/(main)/actions/page.test.tsx` — the focus-management tests ("keeps
  focus in the same Fix/Decide slot…") fail order-dependently in full runs and
  pass when the file runs alone, so they likely leak focus or timer state
  between cases.

Both must keep guarding what they currently guard: that PDF.js stays external
and repeated extraction works, and that Action Center keyboard focus survives a
card leaving its lane.

**Effort:** S.

**Delivered:** Both guards are intact; neither was serialized and no assertion
was loosened.

The PDF one is genuinely load-sensitive but was not reproducing on demand —
the same test measured 399ms, 3136ms and 2137ms across identical runs, an 8x
spread that makes the 5s default reachable under contention. The esbuild bundle
moved into a shared `beforeAll` (built once for the file instead of per test)
with explicit, commented per-test timeouts; `testTimeout` was left alone.

The Action Center one had a different cause than the entry assumed — **not**
leaked focus or timer state. Vitest runs each file in its own forked process
with `isolate: true`, so cross-file leakage is architecturally impossible here.
Reproduced under `--sequence.shuffle`: one test fired `ArrowRight` before the
passive-effect flush that registers the keydown listener, so the handler closed
over an empty action list and dropped the key, which no later `waitFor` can
recover. Every other keyboard test in the file already awaited initial focus —
that one was the outlier. Fixed by awaiting focus first, verified across
repeated shuffled runs.

Noted for later, not fixed: `--sequence.shuffle` repacks files across workers
and produces scattered *timeout* failures in unrelated suites (PayslipDetailPanel,
bulk-upload-ui, InvestmentTransactionForm, the docs layout). Those are
contention-sensitive rather than order-dependent, and none recur in normal runs —
worth knowing if CI ever gets slower.

---

## P1 - Lot Scrub and Investment-Type Correctness (2026-08-04 audit)

**Status:** Engine fixes for all 8 findings implemented 2026-08-04 (single
`isLongTerm` in `src/lib/holding-period.ts`; transfer-close skips gains and
carries basis via a `carried_basis` lot slot; zero-value trades valued from
the price DB with refuse-to-book fallback and stock splits scale lots;
per-sale LIFO replay with acquisition-date FIFO ordering; oversell remainder
left unassigned; ledger rows sum sub-splits; wash-sale exclusions;
preference-flag/account-type classification with commodity-aware epsilons).
**Remaining:** the supervised prod data repair —
`scripts/repair-transfer-lot-gains.mjs` (dry-run by default, `--apply` to
write) reverts the transfer-close gains transactions, re-links carried
basis along transfer chains, and reports the 106 no-offset lots.
**Rehearsed 2026-08-04** on a fresh prod snapshot (`gnucash_rehearsal` on
truenas:5432, kept for comparison): the true inventory is **82 lots /
−$235,065.76** (the audit's 84/−$236,065.76 netted a 2019 +$1,000 phantom
gain differently) — 80 pure transfer-closes plus two lots whose zero-value
disposals against same-account/TRADING counters are adjustments, not sales
(classifier extended accordingly). Apply verified: idempotent re-run, exact
per-year reconciliation (2024 −$5,061.11 / 2025 −$1,518.66 match the audit),
VOO carried basis $199,265.93 on the Ally lot, zero orphans created. (The
"897 orphaned `gnucash_web_generated` slots" flagged that day were a
diagnostic error — they attach to LOT guids, which the check omitted; the
2026-08-04 cleanup script `scripts/cleanup-orphaned-slots.ts` checks every
attach type and finds zero true orphans on prod. Six genuinely leaking
delete paths — transaction DELETE/PUT, audit undo, book delete, XML
re-import collision clear, package delete — were found and fixed with a
guard test in the same pass.) **Prod repair executed 2026-08-04**: backup at
`~/gnucash-prod-pre-lot-repair-20260804-160304.dump` on the truenas host,
dry-run matched the rehearsal exactly, apply reverted 82 gains transactions
and wrote 95 carried-basis slots, and every verification (idempotent re-run,
per-year reconciliation, VOO carried basis, zero orphan splits) matched the
rehearsal row for row. **Sweep of the 106 no-offset lots resolved
2026-08-04**: `scripts/sweep-lot-gains.ts` runs the real engine
(`generateCapitalGains`) on every closed lot missing a gains offset; on both
the rehearsal snapshot and prod (dry-run, rolled back) the engine correctly
books NOTHING — all 106 sit under Roth IRA / HSA accounts (the audit's
"none sit under Roth/HSA" claim was wrong) and are TAX_EXEMPT skips, and
the other candidates are the 80 correctly-repaired transfer-closed lots
plus one zero-proceeds disposal and one break-even. No data change needed.
This item is fully CLOSED. Findings kept below
for reference. Audited files: `src/lib/lot-scrub.ts`,
`src/lib/lot-assignment.ts`, `src/lib/lots.ts`, `src/lib/cost-basis.ts`, and
`src/components/ledger/investment-utils.ts`, each verified with read-only
queries against the prod database on truenas (`gnucash-web-prod-postgres-1`).

### 1. Transfer-closed lots generate phantom realized gains/losses — data + engine

`generateCapitalGains` fires for every lot whose shares sum to zero, including
lots closed by a **transfer-out** to another account. A transfer is not a
taxable event, but the engine books `proceeds − basis` against the transfer
value anyway. When the transfer transaction carries zero value (the common case
in this book), the source lot books a phantom **loss equal to its full basis**,
and the destination lot opens with **zero basis** (`linkTransferToLot` carries
`acquisition_date` but not cost), so the eventual real sale books a phantom
gain of the full proceeds.

Prod impact (verified 2026-08-04): 84 transfer-closed lots, **all 84** carrying
`gnucash_web_generated` gains splits, summing to **−$236,065.76** of recorded
phantom loss; 93 lots have positive shares-in with ~$0 basis, of which 38 are
closed with $2,604.79 of overstated gains already booked. These flow into
realized-gain reporting (8949 / capital-gains surfaces) with wrong amounts in
the wrong tax years.

Fix direction: in `generateCapitalGains`, detect that the lot's closing
negative split belongs to a transfer transaction (same-commodity positive
counter-split in another non-TRADING account — the same predicate
`splitTransferAcrossSourceLots` already uses) and **skip gains generation**;
instead carry the source lot's remaining basis into the destination lot
(rewrite the transfer splits' value to basis, or store a `carried_basis` slot
the gains pass consumes later). Then a data repair: revert/regenerate the 84
transfer-gains transactions. **Effort:** M, plus a supervised prod repair.

### 2. Zero-value crypto-to-crypto trades scrub into phantom losses

60 splits on STOCK/MUTUAL accounts change quantity with `value_num = 0` and no
same-commodity counter-split — all crypto-to-crypto trades ("Buy ETH": ETH +3 /
BTC −0.0696, both $0). The scrub treats the negative side as a **$0-proceeds
sell** (phantom loss equal to consumed basis) and the positive side as a
**zero-cost buy lot** (phantom gain later). Fix direction: value these trades
at the price-DB rate on the trade date during scrub (or flag them as warnings
and refuse to book a gain from a $0-value sell). The same shape covers true
stock splits/reverse splits, which should scale existing lots rather than open
zero-cost lots or realize $0-proceeds "sales". **Effort:** M.

### 3. LIFO assignment is anachronistic

`assignWithStrategy` creates lots for **all** buys first, then processes sells
against a single statically-sorted lot list. Under LIFO, a sell consumes the
newest lot **including buys dated after the sell**. True LIFO must consume, per
sell, the newest lot existing **at the sell date**. FIFO is safe (chronological
replay), but FIFO ordering for transferred lots uses the transfer date instead
of the carried `acquisition_date`, so transferred (older) shares are consumed
after newer direct buys. **Effort:** S–M. (`cost-basis.ts` already implements
the correct per-sale replay — see `consumptionOrder` — and can serve as the
reference.)

### 4. Oversell handling is inconsistent and can corrupt a lot

When a sell exceeds all open lots (`splitSellAcrossLots`): with multiple lots,
the "remainder" logic dumps the un-allocatable excess into the **last lot**,
leaving it with negative shares (warning only); with a single lot, the split's
quantity/value are rewritten smaller, the transaction stops balancing, and the
invariant check throws — failing the whole account scrub with a cryptic
"balance invariant violated". Desktop GnuCash leaves the unallocatable
remainder **unassigned**. Do that in both paths and keep the warning. No prod
lots are currently negative (verified), so this is latent. **Effort:** S.

### 5. Two conflicting long-term rules

`classifyHoldingPeriod` (lot-scrub) uses a 365-day millisecond threshold;
`isLongTerm` (reports/capital-gains, used by lots UI and 8949) uses the
IRS-correct calendar-anniversary rule. They disagree on exact-anniversary sales
across leap years (366 days elapsed = still short-term per IRS; the scrub calls
it long-term and posts to the **Long Term** gains account while 8949 reports
short-term). Unify on `isLongTerm`. **Effort:** S.

### 6. Investment ledger row reads only the first account split

`transformToInvestmentRow` uses `splits.find(s => s.account_guid ===
accountGuid)`, but the scrub engine sub-splits sells/transfers into multiple
same-account splits. A scrubbed multi-lot sell displays only the first
sub-split's shares/value/price. 109 (transaction, account) pairs in prod have
multiple nonzero-quantity stock splits today. Sum the account's splits the way
the API route already does for the running balance
(`src/app/api/accounts/[guid]/transactions/route.ts`). **Effort:** S.

### 7. Wash-sale detector false positives

`detectWashSales` counts **any** positive-quantity split as replacement shares:
(a) the sold shares' own purchase within 30 days flags the sale against itself
(IRS excludes the shares bought-and-sold in the wash; 677 prod sells have a
same-account buy within the prior 30 days — DRIP-heavy accounts drown in
noise); (b) transfer-in sub-splits are "buys", so moving shares between own
accounts flags a wash; (c) the no-lot loss heuristic averages **all** buys
including ones after the sell. Exclude the sell's own lot-opening buy and
transfer-ins, and bound the heuristic to buys ≤ sell date. **Effort:** M.

### 8. Fragile name-based classification (lower priority)

- `classifyAccountTax` walks account **names** for roth/ira/401k/hsa; the
  account preference system already has an explicit retirement flag that should
  win when set.
- `classifyInvestmentTransaction` (investment-utils) detects Income/Expense/
  Trading counterparties by fullname prefix instead of `account_type`, which the
  DB knows; renamed roots or non-English books silently misclassify. Ship
  `account_type` on ledger splits and key off it.
- Epsilons: the scrub uses 0.0001-share thresholds throughout; at crypto's 1e8
  precision, 0.0001 BTC is real money — dust below the epsilon is silently
  treated as closed/consumed.
- `generateCapitalGains` books a $0-value gains transaction when a lot closes
  at exactly break-even — harmless but noisy.

**Effort:** S each.

### Data-health note (no code change decided)

106 closed lots have a nonzero value sum and **no** gains offset split.
~~None sit under Roth/HSA accounts~~ — **correction (2026-08-04 sweep): all
106 sit under Roth IRA / HSA accounts** and are exactly the TAX_EXEMPT skip
path; the engine correctly declines to book gains there. Verified against
prod with `scripts/sweep-lot-gains.ts` (engine-driven, dry-run). No repair
needed.

---

## P1 - Tax Estimator and Withholding Correctness (2026-08-04 audit)

**Status:** Findings 2, 3, 4, 6 (farmer rule + §7503 rolling), and 7
implemented 2026-08-04: shared input assembly in
`src/lib/tax/estimator-inputs.ts` now feeds the estimator page, withholding
checkup, and `/api/tax/estimated` (which held a third divergent copy, now
deleted); scenarios route trad-IRA additions through
`computeIraDeductionLimit`; paycheck uses `additionalMedicareThreshold`;
`computeSafeHarbor` models the §6654(i) qualifying-farmer single 66⅔% Jan 15
installment behind an explicit flag and all due dates roll per §7503; NIIT
loss clamp removed, `priorYearCapitalLossCarryover` input added with
carryover-out on the result, tax-schedule mirror sheltered guard added, MFS
Roth simplification documented. **Findings 1 and 5 implemented 2026-08-04
(wave 2):** the estimator, withholding checkup, and tax package now consume
the same per-sale extraction as the 8949 (`lotToRealizedSales` in
`src/lib/reports/capital-gains.ts` — per-sale year attribution, open-lot
realized portions, UTC bucketing, carried basis/dates, shared `isLongTerm`;
this also fixed the 8949's own per-lot rows), and the OBBBA individual
provisions are modeled with statute-verified parameters: §224 tips and §225
overtime deductions (2025-2028, per-return caps, floor-rounded phase-outs,
MFS excluded per the joint-filing requirement), §163(h)(4) car-loan
interest (ceiling-rounded phase-out), the 2026 §170(q) 0.5% AGI charitable
floor, §170(p) non-itemizer charitable deduction, and the §68 2/37
itemized limitation (correct measure: taxable income before §68 plus
itemized deductions over the 37% bracket start). **Remaining: none — Form
2210 Sch. AI annualized installments implemented 2026-08-11:**
`src/lib/tax/annualized-installments.ts` (pure Schedule AI lines 21-27
column flow: 22.5/45/67.5/90% percentages, 4/2.4/1.5/1 annualization
factors, recapture, qualifying-farmer exclusion, open-period fallback to
the even schedule), period-bounded book aggregation (`throughDate` on
`aggregateBookTaxData`; realized gains bounded by sale date and annualized
by the statutory factor per the form), a `requiredCumulativeByQuarter`
override on the quarter tracker, a Schedule AI comparison section and
per-quarter "annualized" badge on /taxes/estimated, and trace/assumption
coverage. Documented simplifications: SE tax uses the full-year Social
Security wage base (Sch AI Part II proration not modeled — identical below
the cap); withholding, retirement contributions, and linked-business profit
are treated as accruing evenly through the year. Original audit scope:
`src/lib/tax/federal.ts`,
`src/lib/withholding.ts`, `src/lib/tax/{book-income,payments,estimated-quarters,
paycheck,phaseouts,scenario,suggest,tax-schedule}.ts`, `src/lib/tax/state/`,
and the estimator page wiring, with prod-data verification on truenas. The
pure federal engine held up well: 2024/2025 constants match the Rev. Procs. +
OBBBA, the QSS-vs-others Additional Medicare distinction is right, MFS is
correctly excluded from the senior deduction, the Pub 915 muni-interest
handling is correct, and there are 59 federal engine tests. The findings are
mostly at the seams.

### 1. Estimator capital gains inherit the lot-engine defects — and add their own

`aggregateBookTaxData` builds STCG/LTCG **only** from closed lots
(`src/lib/tax/book-income.ts`). Three problems, all verified in prod:

- **Phantom transfer gains flow into supported tax years**: the transfer-close
  gains from the lot audit land −$5,061.11 in 2024 and −$1,518.66 in 2025
  STCG/LTCG (the −$220k bulk is in 2023). The estimator, withholding checkup,
  and tax package all consume these.
- **Open (partially-sold) lots are skipped entirely** (`if (!lot.isClosed)
  continue`), even though `computeRealizedGain` already returns the realized
  portion of open lots. Prod: 2 open lots with **$36,607** of 2025 sale
  proceeds contribute zero realized gain to the 2025 estimate.
- **Whole-lot gains attributed to the close year**: a lot with sells across
  years books its entire gain in the final year. 22 closed lots in prod span
  multiple sell years. The 8949 report does per-sale rows; the estimator
  should follow the same per-sale attribution (share
  `loadRealizedSales`-style extraction instead of per-lot sums).
- Also: a **fourth** copy of the long-term rule (`ONE_YEAR_MS` 365-day
  threshold at book-income.ts:25) disagreeing with `isLongTerm`, and year
  bucketing via local-time `getFullYear()` on a UTC ISO date. Unify on
  `isLongTerm` + UTC.

**Effort:** M. Fixing the lot engine first (previous section) is a
prerequisite for the data to come clean.

### 2. Withholding checkup diverges from the estimator it mirrors

`buildFederalInputsFromBook` (withholding.ts) rebuilds the estimator's
`buildInputs` but skips two things the estimator page applies:

- **No Child Tax Credit**: `qualifyingChildrenUnder17` is never set (the page
  pulls `entity.dependentsUnder17`; the checkup loader has no input for it).
  A family with 2 kids sees liability overstated by $4,400 and gets told to
  over-withhold.
- **No trad-IRA deduction phase-out**: the page caps
  `traditionalIraContributions` at the §219(g) deductible limit via
  `computeIraDeductionLimit`; the checkup deducts the full contribution, so
  covered high-MAGI filers see understated liability.

Extract the page's input-assembly (CTC + phase-out cap) into a shared helper
both surfaces call. **Effort:** S–M.

### 3. Paycheck model uses the NIIT threshold for Additional Medicare

`paycheck.ts:129` reads `getYearStatusParams(...).niitThreshold` for the 0.9%
Additional Medicare wage threshold. For QSS the two differ ($250k NIIT vs
$200k §3101(b)(2)) — and `federal.ts` already exports
`additionalMedicareThreshold(filingStatus)` documenting exactly this trap.
One-line fix. **Effort:** XS.

### 4. Contribution scenarios ignore IRA deductibility

`applyScenario` adds hypothetical trad-IRA dollars straight into
`traditionalIraContributions`; validation checks only the *contribution*
limit. The base estimate applies the §219(g) phase-out, but a "max out
traditional IRA" scenario for a plan-covered filer above the MAGI range shows
tax savings that don't exist. Route scenario additions through
`computeIraDeductionLimit` (same MAGI-without-IRA pass the page already
does). **Effort:** S.

### 5. Missing OBBBA individual provisions (2025 ones are live now)

Not modeled anywhere: **tips deduction** and **overtime deduction**
(2025-2028), **car-loan interest** deduction (2025-2028), the 2026 **0.5% AGI
floor** on itemized charitable contributions, the 2026 **non-itemizer
charitable deduction** ($1,000/$2,000), and the 2026 **2/37 itemized
limitation** for 37%-bracket filers. The header documents the §199A
simplifications but none of these. At minimum add inputs for tips/overtime
(they change 2025 returns) and the 2026 charitable floor; document the rest
as known simplifications. **Effort:** M.

### 6. No farmer safe harbor, despite the farm feature set

`computeSafeHarbor` models only 90%-current / 100%/110%-prior with four equal
installments. IRC §6654(i): a qualifying farmer (⅔ of gross income from
farming) owes a **single Jan 15 installment of 66⅔%** of current-year tax —
and this product ships Schedule F, a farm analyzer, and NC farm rules, so the
person most likely to use it qualifies. Also: due dates are not
weekend/holiday-rolled here (the compliance calendar pre-rolls per §7503 —
inconsistent), and the annualized-installment method (Form 2210 Sch. AI) is
absent, which penalizes lumpy income in the quarter tracker. **Effort:** S
for the farmer rule + date rolling; M for annualized installments.

### 7. Smaller correctness notes

- **NIIT loss clamp** (federal.ts:510): `Math.max(0, cg.includedInAgi)` —
  Form 8960 lets the allowed capital loss (−$3,000) reduce net investment
  income; clamping overstates NIIT in loss years. **XS.**
- **Capital-loss carryover**: no input for prior-year carryover, so loss
  years' −$3,000 cap discards the excess with no way to model next year.
  **S.**
- **Tax-schedule sheltered guard is one-sided** (tax-schedule.ts): it has the
  retirement-counter guard but not the asset-side mirror guard book-income.ts
  carries — an IRA internal dividend can still land on the tax schedule
  report via a mapped sheltered asset account, though it is excluded from the
  estimator. Same-guard parity, per the contribution-summing-paths rule.
  **S.**
- **Roth phase-out for MFS living apart** uses the 0–10k range
  unconditionally (IRS allows single ranges when living apart all year) —
  acceptable simplification, but undocumented, unlike the QSS note beside it.
  **XS (doc).**

---

## P2 - Filing Status as a Global Setting, Inherited by Feature Packs

**Status:** Implemented 2026-08-04.

**Delivered:** `src/lib/tax/filing-status-inheritance.ts` models
inherited/override/divergence states (a stored value equal to the profile
collapses to inherited and stops being persisted); a shared
`FilingStatusSourceNote` renders the "differs from household setting" note
with one-click revert. Converted: withholding checkup, paycheck modeler,
sell planner (server context now profile-first), drawdown planner (seeds
from profile instead of hardcoded MFJ), scenario sandbox (was reading only
the user preference — real bug), tax estimator (edits the profile and
invalidates the shared cache), and Settings gained the missing Filing
Status field on the entity editor. Estimated taxes, bunching, farm/S-corp
analyzers, tax package, and resilience packs were already profile-first.
Divergent stored configs are flagged, never rewritten.

**Outcome:** Filing status is set once, in household/entity settings, and
every tax-aware surface inherits it — the same "define the person once"
principle as the household roster work. Today
`gnucash_web_entity_profiles.filing_status` exists and is read by the
resilience packs, scenario data, and the sell planner, but other surfaces
(tax estimator page state, withholding checkup, estimated taxes, charitable
bunching, farm/S-corp analyzers, and any pack that asks for filing status in
its own form) carry their own copy that can silently disagree with the
profile.

Work:

1. Treat `entity_profiles.filing_status` as the single source of truth.
   Every consumer seeds from it by default; a surface-local selector becomes
   an explicit, visually-marked scenario override ("differs from household
   setting — Settings link"), never a silently divergent stored copy.
2. Audit all `filingStatus` call sites (~65 files) and re-point stored
   per-tool copies (tool configs that persist a filing status) to the
   shared value, with a one-time migration that flags configs whose stored
   status disagrees with the profile rather than guessing.
3. Changing the global setting must visibly ripple: surfaces that cached a
   divergent value should surface the mismatch, not keep stale state.
4. Keep the pure engines pure — they still take `filingStatus` as an input;
   this item is about where the value comes from (service/page seams), same
   pattern as household-roster resolution.

**Depends on:** entity profiles, `estimator-inputs.ts` seams, tool-config
persistence, household settings UI.

**Effort:** S-M.

---

## P2 - MFJ vs MFS Filing Comparison with Breakeven Analysis

**Status:** Implemented 2026-08-04.

**Delivered:** `src/lib/tax/filing-comparison.ts` splits book data per
spouse via `gnucash_web_account_preferences.owner` (payslips post into
owned wage accounts, so account owner covers both wage and investment
attribution), with explicit residual sliders for joint/unowned amounts and
a CTC-claimant choice; both sides assemble through the shared
estimator-inputs helpers. Comparison runs MFJ vs MFS×2 (each MFS side
evaluated under both legal deduction combinations) plus a clearly-labeled
hypothetical single×2 lens; ranked per-line divergence explanations and an
always-visible caveats panel (EITC, education credits, student-loan
interest, IDR plans, itemization symmetry). Breakeven sweep over spouse
wages / deduction allocation / added LTCG with crossover interpolation and
a recharts chart marking "now" and "breakeven". Engine gap found and
fixed: §63(c)(6)(A) — an MFS filer whose spouse itemizes has a zero
standard deduction (`mfsSpouseItemizes` input). New page at
`tools/filing-comparison` with empty states for non-MFJ/QSS books.

**Outcome:** A couple can see, from their real book data, whether filing
jointly or separately is better this year, by how much, and where the
breakeven sits — because separate filing is *sometimes* the win and almost
no consumer tool shows the crossover. Secondary lens: a marriage-penalty /
bonus view (two-single baseline vs MFJ) for context.

The federal engine already models most of the MFS-specific rules this needs
(separate brackets and thresholds, $1,500 capital-loss cap, 0–10k IRA
phase-out range, NIIT/Additional-Medicare thresholds, senior-deduction and
OBBBA tips/overtime exclusions for MFS, SALT cap halving), so the core is an
allocation-and-compare pass, not new tax law:

1. **Income/deduction allocation.** Split the household's aggregated book
   data into per-spouse columns: W-2s and withholding by payslip owner,
   investment income by account owner (household roster owner links where
   present, explicit allocation UI where not), itemized deductions per the
   MFS allocation rules (both itemize or both take standard; community-
   property states out of scope, documented).
2. **Three engine runs** (MFJ, MFS×2, and optionally single×2 for the
   penalty view) over identical data, with a side-by-side result table and
   per-line evidence traces of where the outcomes diverge (credits lost
   under MFS, bracket effects, threshold crossings).
3. **Breakeven sweep.** Hold one variable (e.g. spouse-2 income, a
   deduction allocation, or a capital-gain realization) and sweep it to find
   the crossover point where MFS overtakes MFJ (or show "MFJ wins across
   the whole range"), rendered as a small chart with the current position
   marked.
4. **Honest caveats surfaced in the result**, not fine print: MFS kills
   EITC/education credits and the student-loan interest deduction, forces
   itemization symmetry, and interacts with income-driven student-loan
   plans (a non-tax reason MFS wins that the tool should mention but not
   model).

**Depends on:** federal engine (already MFS-aware), estimator-inputs
seams, payslip owner attribution, household roster owner links, the
filing-status global setting above.

**Effort:** M.

---

## P2 - Abbreviation Glossary with Hover Tooltips (app-wide)

**Status:** Implemented 2026-08-04.

**Delivered:** Dependency-free `Tooltip` primitive in `src/components/ui/`
(portal-rendered, viewport-aware flip/clamp, hover/focus/tap triggers,
Escape-to-dismiss, `aria-describedby`, DESIGN.md tokens), `src/lib/glossary.ts`
(~78 terms), and `<Abbr term="…">` with dotted underline + (i) glyph and
plain-text fallback for unknown terms. Retrofitted first-occurrence-per-view
across 18 dense surfaces (tax estimator, withholding checkup, 8949/Schedule D,
lots, harvesting, TXF schedule, tax package, contribution summary, Schedule F,
farm/S-corp analyzers, estimated taxes, bunching, sell planner, HSA shoebox,
FIRE calculator, FX revaluation, investment ledger — `TransactionTypeIcon`
dropped its native `title=`). DESIGN.md has the rule;
`src/__tests__/abbr-coverage.test.ts` fails on new bare abbreviations and on
stale allowlist entries. **Long tail completed 2026-08-04:** all 30
allowlisted surfaces retrofitted and the allowlist emptied; Tooltip gained
a `nested` mode (span trigger, event containment) so hints can sit legally
inside clickable cards/links (LotViewer badges, reports index); new terms
IRMAA, TOD, POD, SS, IDR.

Original request: the app is dense with financial,
tax, and accounting abbreviations that are not obvious to every user.

Every user-visible abbreviation should carry a small (i) affordance that
reveals the expansion (and, where one line helps, a plain-English gloss) on
hover — and on tap/focus for mobile and keyboard users.

**Approach:**

1. **One shared glossary, one shared component.** A central
   `src/lib/glossary.ts` mapping term → { expansion, gloss? } and an
   `<Abbr term="QBI" />` (or `<InfoHint>`) component in `src/components/ui/`
   that renders the abbreviation with the (i) icon and tooltip. There is no
   Tooltip primitive in `src/components/ui/` today — build it once there
   (positioning, delay, `aria-describedby`, Escape-to-dismiss, touch/focus
   trigger) instead of scattering `title=` attributes, and style it per
   DESIGN.md semantic tokens. Native `title=` is not acceptable as the final
   mechanism: no mobile support, no styling, poor discoverability — the (i)
   icon is the point.
2. **App-wide audit to find them.** Sweep every user-facing surface (pages,
   components, report headers/columns, chart legends, empty states, toasts)
   for abbreviations. Non-exhaustive starter list from recent work: AGI,
   MAGI, QBI, SE, NIIT, SALT, LTCG/STCG, CTC/ACTC, HSA, FSA, IRA, SEP,
   SIMPLE, RMD, QSS/MFJ/MFS/HOH, 1040-ES, TXF, 8949, W-2/W-9, 1099, 990-N,
   DRIP, ROC (the ledger's TransactionTypeIcon labels), G/L, FIFO/LIFO, FICA,
   OASDI, SCU, AR/AP, COGS, QBO, PUV, FIRE, KPI, YTD, FX, ES (estimated
   tax), plus business/farm terms (Schedule C/E/F as "Schedule F (Form 1040),
   Profit or Loss From Farming", §179, §1091, OBBBA). The audit should also
   catch column headers like "ST/LT" and axis/legend labels in charts.
3. **Coverage without noise.** First occurrence per view gets the (i);
   repeated occurrences in the same table column don't need one each — put
   the hint in the column header. Keep tooltips to one or two sentences; link
   to the docs page for anything needing more.
4. **Keep it maintainable.** A lint-style check (or test) that greps new UI
   strings for known glossary terms rendered without `<Abbr>` would stop
   regressions; at minimum, add the rule to DESIGN.md so new surfaces adopt
   it.

**Effort:** M–L (the component and glossary are S; the app-wide sweep and
retrofit are the bulk).

---

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

---

# Engineering quality backlog — ASI review 2026-08-04

Findings from the full-stack ASI review at commit 9c4c148. Full evidence,
file:line citations, impact scenarios, and regression tests for every item are
in [asi-review.md](asi-review.md) under the referenced ID. These are defect
fixes and hardening, so the feature-backlog admission checklist does not apply.

**Reconciled 2026-08-19** against main `45fb1e5` after the polly/* audit-fix
branches were all merged: every unchecked box below was re-verified in code
(not by commit message). 31 were already fixed and are now ticked with their
evidence; items marked **Partial** say exactly what remains; the rest carry
"Verified open 2026-08-19". Two TXF/farmer items are open *by decision*
(reverted after double-counting in TurboTax) and say so.

## Do immediately

- [x] **Rotate the committed app password** and move Playwright specs to
  `E2E_USER`/`E2E_PASS` env vars (`tests/test-reports.spec.ts`,
  `tests/e2e/review-mode.spec.ts`, `tests/test-investment-charts.spec.ts`).
  (ASI-3-001) — Password rotated 2026-08-05; the committed string is now
  inert. Switching the specs to env vars (and deleting the two dead
  root-level specs) is folded into the e2e cleanup item (ASI-2-002).

## P1 — High findings

- [x] **CI gate:** run `vitest run` + `lint` as a required job before the
  image build in `deploy.yml`. (ASI-2-001)
- [x] **Build integrity:** remove the four TLS-off lines in the Dockerfile and
  switch both installs to `npm ci`. (ASI-3-002)
- [x] **FX triangulation:** fix the `'triangulated'` exact-match guard at
  `currency.ts:213` and bound the recursion so a missing USD/EUR price can't
  hang requests. (ASI-1-001)
- [x] **Carried basis in lot summaries:** make `lots.ts` gain/cost math use
  `carried_basis` like the scrub engine and 8949 already do — fixes inflated
  gains on transferred lots and missed tax-harvesting losses. (ASI-1-002)
- [x] **db-init safety:** add a schema-meta tracking table, and
  backup-or-gate the destructive statements (price dedupe delete, tool_config
  deletes, native GnuCash index drops). Resolve first whether desktop GnuCash
  still opens the prod DB. (ASI-7-001, ASI-8-001)
- [x] **Rollback runbook:** document previous-SHA pin procedure for the
  Dockhand stack; consider a `stable` tag pushed after a health probe.
  (ASI-7-002)
- [x] **`jh-401k-separate.mjs`:** flip to default-dry `--apply`, read
  `DATABASE_URL`, print target DB, wrap mutations in a transaction.
  (ASI-4-001) — Resolved 2026-08-05: one-off script already served its
  purpose; retired from tracking (commit f4facea).

## P2 — Medium findings

Correctness:
- [x] Wash-sale detection: carried-basis-aware loss test + consume replacement
  shares per buy. (ASI-1-003)
- [x] "Average" cost basis silently runs FIFO and books gains — implement or
  label with a warning. (ASI-1-004)
- [x] Monthly recurrence with forward weekend adjust skips a month after a
  cross-month adjustment. (ASI-1-005)
- [x] Composite/semi-monthly recurrences: honor multiple recurrence rows per
  SX; derive semi-monthly anchors from `periodStart`; respect `mult`.
  (ASI-1-006)

Security:
- [x] Gate OIDC auto-provisioning (registration gate / allowlist; no automatic
  all-books readonly grant). (ASI-3-003)
- [x] AI-query guardrail: require every scoped table reference to be bound to
  the book's account set, not just one `$1` anywhere. (ASI-3-004) — The
  2026-08-05 fix was validated on 2026-08-06 and **five bypasses still worked**,
  two reaching arbitrary tables. Re-fixed by removing the model-supplied scope
  predicate entirely: the model now reads only `book_*` CTEs that the guardrail
  defines with `$1` bound, over a real tokenizer. See ASI-3-004 in
  [asi-review.md](asi-review.md).
- [x] Dependency updates: `npm audit fix` batch; plan Next 16.3 + sharp 0.35
  upgrades; replace unfixable `node-tesseract-ocr` (call tesseract via
  `execFile` or use `tesseract.js`). (ASI-3-005)
- [x] Pin GH Actions to SHAs; use `GITHUB_TOKEN` instead of CR_PAT; add a
  secret to the Dockhand webhook and fail the job on webhook errors.
  (ASI-3-006)

Ops / reliability:
- [x] Standardize repair scripts: shared target-DB banner, prod confirm guard,
  default-dry `--apply` everywhere. (ASI-4-002, ASI-4-004) — Resolved
  2026-08-05: the one-off repair scripts are done and retired from tracking
  (commit f4facea). Adopt the banner/guard convention if a new repair script
  is ever written.
- [x] Dev compose: shared volume for `/app/data/receipts` (OCR worker
  currently can't see app uploads; recreate deletes documents). (ASI-4-003)
- [x] Worker: add BullMQ `error` listener + `unhandledRejection` backstop.
  (ASI-5-001)
- [x] Worker: guard schedule callbacks in `setScheduleGeneric` so one failure
  can't end a schedule chain (backups). (ASI-5-002)
- [x] Web Redis client: replace the permanent `connectionFailed` latch with a
  cooldown retry. (ASI-5-003)
- [x] Worker Redis connection: honor the `db` index in `REDIS_URL` like the
  enqueue side. (ASI-5-004)
- [x] SimpleFin: don't advance `last_sync_at` past failed transaction imports.
  (ASI-5-005)
- [x] Email ingest: claim dedup key before processing + in-flight guard to
  prevent double-ingestion. (ASI-5-006)
- [x] Startup env validation: assert `DATABASE_URL` and a ≥32-char session
  secret in the entrypoint with named errors. (ASI-7-003)
- [x] Health checks: Dockerfile/compose HEALTHCHECKs (worker health port
  already exists); make deploy webhook failures fail the workflow. (ASI-7-004)

Performance:
- [x] Batch lot loading for capital-gains/tax surfaces (merge the 4 slot
  queries; `getLotsForAccounts`). (ASI-6-001)
- [x] Cache investment-ledger running totals so infinite scroll stops
  recomputing full cost-basis history per page. (ASI-6-002)
- [x] Price backfill: hoist USD lookup, batch inserts. (ASI-6-003)

Tests:
- [x] Unit-test `findExchangeRate`/`convertAmount` (direct/inverse/
  triangulated/none/stale + recursion bound). (ASI-2-003)
- [x] Fix or quarantine the e2e suite (testDir mismatch, hardcoded port,
  data-dependent skips; use demo-seed). (ASI-2-002)

## P4 — Low findings (backlog when touching the area)

- [x] Mortgage original-amount fallback double-counts (ASI-1-007) — done 2026-08-19: `detectOriginalAmountWithConfidence` groups opening credits per tx and separates material/absorbed later credits (polly/mortgage-confidence).
- [x] UTC age calc for Dec 31 birthdays (ASI-1-008) — done 2026-08-19: `calculateCalendarAge(…, 'utc')` in `irs-limit-tables.ts`; TZ pinned in vitest config (polly/age-consolidation).
- [x] Price-staleness warnings (ASI-1-009) — done 2026-08-19: `src/lib/price-staleness.ts`; `currency.ts` lookups return `stale`/age (polly/price-staleness).
- [x] Balance-sheet `grandTotal` retained-earnings line (ASI-1-010) — done 2026-08-19: synthetic retained-earnings equity row in `balance-sheet.ts:144-166`.
- [x] Env-gated Postgres integration test for db-init (ASI-2-004) — done 2026-08-19: `src/__tests__/integration/harness.integration.test.ts` asserts db-init objects against the CI postgres:17 service. Remaining nicety: no `lib/reports` query runs in the integration tier yet.
- [ ] Fake timers in "today"-relative tests (ASI-2-005). Still no `setSystemTime`/`useFakeTimers` (e.g. `lots-holding-period.test.ts`, `membership.service.test.ts`); only the TZ pin mitigates.
- [ ] Webhook DNS re-resolution (ASI-3-007). `src/lib/webhooks.ts` still does not resolve before `fetch`.
- [x] Security headers (ASI-3-008) — done 2026-08-19: `next.config.js` `headers()` (X-Frame-Options, HSTS, …).
- [ ] Remove weak compose credential fallbacks (ASI-3-009). **Partial 2026-08-19:** `POSTGRES_PASSWORD:?` is required and postgres binds 127.0.0.1. Remaining: `minioadmin` fallbacks in `docker-compose.prod.yml` (app/worker/minio/createbuckets env).
- [x] Backup precondition enforced in `fix-lot-scrub-sign-corruption.ts`
  (ASI-4-005) — Resolved 2026-08-05: script already run and retired from
  tracking (commit f4facea).
- [x] Gzip bomb cap in XML import (ASI-4-006) — done 2026-08-19: `gunzipSync(data, { maxOutputLength })` 256 MB default, env override (`gnucash-xml/parser.ts`).
- [x] Log rotation + `data/` in `.dockerignore` (ASI-4-007) — done 2026-08-19: `logging: max-size 10m` on all prod services; `.dockerignore` has `data/`.
## Follow-up wave — 2026-08-06 validation of the fixes above

Validating the 2026-08-05 fix commit found one fix that failed (ASI-3-004,
above), one that introduced a new bug, and several residuals of the same bug
class the original fix missed. All are now closed:

- [x] Email ingest claimed the dedup key before processing but never released
  it, so a crash or ordinary worker redeploy mid-ingest skipped that message
  forever while it stayed unread. Stale `processing` claims are now reclaimable
  after 15 minutes, with a bounded retry budget (also closes ASI-5-007).
- [x] The ASI-1-005 weekend-adjust fix covered the monthly family but not
  `periodType: 'year'`, so a yearly schedule whose date adjusts across a year
  boundary still skipped a year.
- [x] SimpleFin no longer advancing its cursor past a failure (ASI-5-005) meant
  a *permanently* failing row pinned the window forever, growing it without
  bound and re-notifying every 2 hours. Window clamped to 30 days; failure
  notifications keyed on a stable error fingerprint. The same timestamped
  notification key in `notifications.ts` is fixed to match.
- [x] Price batching (ASI-6-003) aborted a whole 500-row chunk if it contained
  two rows for one commodity-day. Rows are de-duplicated before chunking, with a
  per-row fallback; `market-index-service.ts` moved onto the batched path.
- [x] Dev compose probed the app healthcheck over a hostname that can resolve to
  IPv6 — the bug `aa314af` fixed in prod but never mirrored to dev.
- [x] `worker.ts` now validates its own startup env instead of relying on the
  entrypoint; the web-process BullMQ `Queue` got the `error` listener the worker
  side already had.
- [x] Carried-basis coverage (ASI-1-002) tested only the closed-lot case; the
  open-lot path that feeds tax-loss harvesting is now covered.
- [x] Rollback runbook documents that a pinned `IMAGE_TAG` makes later pushes
  redeploy the old SHA.

Left deliberately: db-init still runs three bounded, app-owned-table mutations
per boot (orphan sweep, 90-day idempotency prune, a no-op backfill UPDATE), so
it does not strictly meet "zero data-mutating statements on a second boot".
None touches GnuCash financial data, and changing db-init carries more
deployment risk than the nit is worth.

- [x] Email-ingest failure notifications (ASI-5-007) — done 2026-08-19: `createNotification` on terminal failure in `email-ingest.ts`.
- [x] Webhook idempotency claim expiry (ASI-5-008) — done 2026-08-19: `WEBHOOK_CLAIM_STALE_MINUTES=5` reclaim in `webhook-idempotency.ts` (polly/webhook-claim-expiry).
- [x] SimpleFin get-or-create advisory locks + book-scoped Imbalance lookup (ASI-5-009) — done 2026-08-19: `getOrCreateImbalanceAccount(…, bookGuid, bookAccountGuids)` + `acquireSoleAccountNameLock` for Imbalance/symbol/Cash children (polly/simplefin-create-race, lock-order invariant).
- [x] OCR temp-file entropy (ASI-5-010) — done 2026-08-19: `mkdtemp` in `ocr-receipt.ts`.
- [x] Validate `refresh_time` + per-book schedules (ASI-5-011) — done 2026-08-19: HH:MM validation with fallback and `setSchedule(bookGuid, …)` in `worker/refresh-schedule.ts`.
- [ ] SimpleFin meta query hoist (ASI-6-004). Unfiltered `transaction_meta.findMany` still inside the per-mapped-account loop (`simplefin-sync.service.ts` ~:710).
- [x] Push amount/reconcile filters into SQL; journal variant applies them (ASI-6-005) — done 2026-08-19: SQL predicates in `accounts/[guid]/transactions/route.ts` and `transactions/route.ts` (polly/asi6005-filter-pagination).
- [ ] Wire up or remove `@tanstack/react-virtual` (ASI-6-006). Still declared in `package.json`, zero imports.
- [ ] Dashboard SQL GROUP BY + invalidation debounce + idx TTLs (ASI-6-007). `dashboard/income-expense` and `sankey` still `findMany` + JS reduce; no debounce in `data-events-subscriber.ts`; `cache.ts` `zadd` without EXPIRE.
- [ ] Worker `stop_grace_period` + timer drain (ASI-7-005). No `stop_grace_period` in any compose file; `worker.ts` `shutdown()` clears book schedules only, not `simplefinTimers`, and does not await in-flight jobs.
- [ ] Prisma ↔ db-init drift check in CI (ASI-7-006). No script/CI step; `sql/001-performance-indexes.sql` still present.
- [ ] Bootstrap race lock (ASI-7-007). `scripts/db-init-entrypoint.ts` `bootstrapIfEmpty` still runs outside the advisory lock.
- [ ] ESLint ignore + triage unused-var warnings (ASI-8-002). **Partial 2026-08-19:** `eslint.config.mjs` now ignores `.worktrees/`, `.claude/`, `.polly/` (full lint 20 min → 43 s). Remaining: 7 warnings — unused `isMultiCurrency` (`api/transactions/route.ts`), `toCents` (`lib/reconcile.ts`), `EMP_A`, `_input`/`_init`, s-corp-analyzer `useMemo` deps.

---

# Correctness backlog — adversarial review 2026-08-12

Source: `ADVERSARIAL-REVIEW-2026-08-12.md` (commit `c788906`). Six independent
read-only audits across three vendors (codex, claude_code, agy) plus a
cross-vendor adjudication of the tax findings; every claim was spot-verified
against source before being recorded, and unverified vendor claims were struck
(see the appendix in that file, including one fabricated finding and one false
CRITICAL, so they don't resurface).

**Re-verified 2026-08-13** against `main` after PR #24 landed. Tier 1 is closed;
every item still listed as open below was re-confirmed present in the source on
that date.

Two structural themes dominate, and both are cheap to fix:

1. **The correct implementation usually already exists but isn't wired to the
   live path.** The reconcile guard, payment idempotency, decimal-safe amount
   parsing, income-vs-expense variance semantics — all present in-repo, all
   bypassed by the code that actually runs.
2. **Exact stored fractions are floated before aggregation**, so the ledger's
   arithmetic is not the arithmetic GnuCash guarantees.

Gate status at review time: 4,689 tests green / 338 files, `tsc --noEmit` clean,
lint 0 errors + 7 warnings. **Every bug below is green-but-wrong**, and the test
suite locks several of them in — the mirror-image assertion is named per item.

## Done — Tier 1 (shipped 2026-08-12, PR #24 `e950e5e`)

- [x] **C3 — Amount input silently booked wrong or zero amounts.**
  `validateForm` tested `parseFloat(amount) <= 0`, so `"$1,234.56"` gave
  `NaN <= 0` → false and booked **$0.00**; `"1,234.56"` booked **$1.00**
  (1000× off). Both reported success. Fixed with a strict parser scoped to
  transaction entry that validates the *original* string's shape before
  normalizing; advanced mode, auto-balance, mode switch, tax shortcut and the
  API payload builder all route through it, and an unparseable split is named
  in an inline error instead of silently counting as 0.
- [x] **C4 — Keyboard save bypassed the in-flight guard → duplicate
  transactions.** `disabled={saving}` covered only the mouse path; Ctrl+Enter
  is a window-level listener. Fixed with a ref-based guard (state still reads
  false on a second press in the same tick) plus a stable per-form-open client
  guid so a retried POST collapses onto one record.
- [x] **H7 — Payment API dropped the idempotency key it already supported.**
  A retried $40 payment posted twice against a $100 invoice. Route now forwards
  `body.transactionGuid`, and `PaymentModal` generates one per modal-open,
  stable across retries.
- [x] **C1 — Budget roll-up double-counted a subtree budgeted at two levels.**
  Budget `Expenses:Auto` $500 + `Expenses:Auto:Gas` $200 with $300 truly spent
  read as *Budgeted $700 / Spent $500*. Totals and Budget Report subtotals/net
  now count only the topmost budgeted account per branch.
- [x] **H12 — FIRE Monte Carlo inflated withdrawals but not contributions.**
  $30k/yr real at 3% over 30 yrs contributed ≈$588k real instead of $900k.
  Contributions now convert to nominal at the end-of-year price level.

## P0 — Silent data corruption (resolved 2026-08-13)

- [x] **C2 — Reconciled splits can be freely edited, deleted, or re-parented.**
  Fixed 2026-08-13. The guard was extracted to
  `src/lib/services/reconciled-split.service.ts` and wired into **11 live write
  paths**, each check running inside the writing DB transaction after the parent
  transactions are locked `FOR UPDATE` in canonical order and before the first
  mutation. Live paths were *not* routed through `TransactionService` — that
  class lacks optimistic concurrency, locking, audit snapshots, trading-split
  handling, and book scoping, so routing through it would have regressed all
  five. Protected splits return **423 Locked** (not 409, which both
  `AccountLedger.tsx` and `TransactionFormModal.tsx` treat as an optimistic-lock
  conflict and silently retry, which would have made the block invisible).
  Lot-engine writes are covered, including `valueZeroValueTrade`, which rewrites
  both trade legs to ±FMV and is *not* a value-preserving repartition.
  Revert compensation is established **per split** via a provenance slot
  (`gnucash_web_parent_split`), not per transaction.
  **Deliberately excluded, with reasons recorded in code:** book deletion (an
  unambiguous admin-level destructive act; guarding it would make every real
  book undeletable) and scheduled-transaction template splits (they live under
  `Template Root`, outside `books.root_account_guid`, so they appear on no
  balance or reconciliation surface — a `y` there is a stale XML-import artifact,
  never a statement agreement).
- [x] **C5 — Inventory permits cross-book ledger postings.**
  Fixed 2026-08-13. `assertPostableAccount` now resolves the account's owning
  book by walking `parent_guid` to a root and matching `books.root_account_guid`
  (`src/lib/inventory-engine.ts:708-746`), rejecting a mismatch at `:753-757`.
  It **fails closed**: an orphan account whose chain never reaches a root
  resolves to `NULL` and is rejected, and a cyclic chain terminates at
  `depth < 200`. `bookGuid` is never request-supplied — all call sites take it
  from `requireRole()`.
  **Note:** this closed the *inventory* path only. The general ledger routes
  still validate account existence without book scoping — see P0 below.

## P0 — Cross-book writes

Re-verified against code at `5c5a555` on 2026-08-14.

- [x] **Transaction create/update accept out-of-book accounts.** Done 2026-08-19: `api/transactions/route.ts` and `[guid]/route.ts` gate every split account with `getAccountGuidsForBook(roleResult.bookGuid)` → 404 (merge 823c0bb3, polly/c5b-ledger-cross-book).
- [x] **SimpleFin sync: check-then-create race.** Done 2026-08-19: `acquireSoleAccountNameLock` around Imbalance/symbol/Cash child creation with a runtime lock-order invariant and a strict 40P01 oracle (polly/simplefin-create-race, `simplefin-create-race.integration.test.ts`).
- [x] **Bulk reconcile lacked book-membership validation.** FIXED 2026-08-14 —
  `src/app/api/splits/bulk/reconcile/route.ts:78-140`. Atomic rejection,
  anti-oracle 404, fail-closed on an empty scope set.
- [x] **Bulk move accepted out-of-book splits and targets.** FIXED 2026-08-14 —
  `src/app/api/splits/bulk/move/route.ts:107-140`. Found by cross-review, not
  by any audit; it could move money between ledgers.
- [x] **Inventory posting permitted cross-book accounts (C5).** FIXED
  2026-08-13 — `src/lib/inventory-engine.ts:708-757`.

## P1 — Data integrity and correctness

Re-verified against code at `5c5a555` on 2026-08-14. The 2026-08-12 adversarial
review's High findings are **almost entirely closed**; what remains is listed
first, then the closures, so this section stops describing shipped work as open.

### Still open

- [x] **H15 — Escape destroys a half-typed multi-split transaction.** Done 2026-08-19: `TransactionFormModal.tsx` dirty check via `isDirty()` + Discard prompt; `Modal.tsx` honours `closeOnEscape` (polly/h15-escape-guard).
- [x] **H9 remainder — aging never ties to the A/R / A/P control account.** Done 2026-08-19: `AgingReconciliation`/`buildAgingControlAccountRows` in `business-reports.ts` with `controlBalance` and `unreconciledDifference` per control account (polly/h9-aging-control-account).
- [x] **No exact server-side same-currency balance check.** Done 2026-08-19: `validation.ts` `assertBalanced` is exact BigInt LCD, no tolerance (polly/exact-server-balance). Still no DB-level balance constraint — tracked as a nicety, not a defect.
- [ ] **Divergent balance tolerances across the codebase.** **Partial 2026-08-19:** settlements `0.011` removed and the create path is exact. Remaining: `0.01` at `mortgage.service.ts`, `capital-gains.ts`, `portfolio/route.ts`; `0.005` ×7 in `lot-scrub.ts` + `statement-reconcile.ts`; `0.0001` share epsilon across 21 non-test files (`DEFAULT_QTY_EPSILON` partially centralises). No single tolerance module. **Effort:** L.
- [x] **Aggregate money in PostgreSQL `numeric`, not `float8`.** Done 2026-08-19: every aggregate site divides in `numeric` and casts once at the boundary — `business-reports.ts`, `jobs.service.ts`, `equity-statement.ts`, `insights.ts`, report utils (polly/float8-*); tripwire test `float8-aggregate-sql.test.ts`. Remaining `::float8` occurrences are boundary/column casts only.
- [x] **Per-account ledger running balance aggregates in float8 before summing.** Done 2026-08-19: windowed `SUM(quantity_num::numeric / …)` with a single outer `::float8` in `accounts/[guid]/transactions/route.ts`.

### Tax — still open

- [x] **Year-parameterize `NEC_THRESHOLD`.** Done 2026-08-19: `getDefaultNecThreshold(taxYear)` / `getNecThreshold`, throws for an unverified year (polly/tax-cluster).
- [x] **Wire `CORP_CLASSIFICATIONS`, or delete it.** Done 2026-08-19: read by `isVendor1099Exempt()` (override wins, else corp classification) in `vendor-1099.service.ts`.
- [ ] **TXF omits realized capital gains entirely.** Verified open 2026-08-19, *deliberately*: a Schedule D/TXF path was added then reverted (ff3d01f5 — double-counted N684/N683, imported 16,800 vs 8,400 into TurboTax). 8949 still emitted separately. Reopen only with a verified TXF reference. **Effort:** M.
- [ ] **TXF `N304` for Traditional IRA may collide with Sch C line 24b.** Still an unverified question (`txf.ts`, `txf-codes.ts` documents N304 as Sch 1 line 20). Verified open 2026-08-19.
- [x] **Credit-card payments not excluded from 1099-NEC (§6050W).** Done 2026-08-19: payments funded from `is_card_payment_source` accounts are apportioned per payable and excluded from the NEC total; unknown funding stays reportable (`vendor-1099.service.ts`, polly/tax-cluster).
- [ ] **Farmer flag not plumbed into the estimated-tax tracker.** Verified open 2026-08-19, *deliberately*: `api/tax/estimated/route.ts` hardcodes `isQualifyingFarmer: false` — ff3d01f5 removed the unreachable election from the household-only tracker. `withholding.ts` support remains. Revisit if the tracker ever gains a farm-book mode. **Effort:** S.
- [x] **Jan 1–15 estimated-payment display is internally inconsistent.** Verified open 2026-08-19: YTD uses `summarizeTaxPayments(bookData, 1)` (calendar-year) while quarter buckets use `quarterForPaymentDate` (prior-year Q4). **Effort:** S. — Done 2026-08-19: new `sumPaymentsForTaxYear()` in `estimated-quarters.ts` buckets by installment window; `api/tax/estimated/route.ts` uses it for `estimatedPayments.totalYtd` and the trace step.
- [x] **Delete a misleading comment.** Verified open 2026-08-19: `annualized-installments.ts:33-41` still says retirement contributions accrue evenly; the route feeds per-period actuals. **Effort:** XS. — Done 2026-08-19: rewrote the Schedule AI simplification bullets (contributions = period-to-date actuals, linked-business prorated, gains annualized) and fixed the same misstatement in the tracker's user-visible assumptions list.

### Closed by the 2026-08-13/14 work

- [x] **H1** — unpriceable holdings no longer valued at $0 and FX no longer
  falls back to parity; excluded and named instead
  (`src/lib/account-valuation.ts:302-317`).
- [x] **H2** — commissions now capitalize into basis and are excluded from tax
  deduction inputs by construction (`src/lib/trade-fees.ts`,
  `src/lib/tax/book-income.ts:173`).
- [x] **H3** — in-kind transfer-outs no longer fabricate a realized loss
  (`src/lib/lots.ts:236-271`, `src/lib/lot-assignment.ts:1361-1401`).
- [x] **H4** — cost basis is traced through transfers; unestablishable basis is
  excluded and named rather than admitted at $0 (`src/lib/cost-basis.ts`).
- [x] **H5** — wash-sale disallowance joins by disposal split GUID, not by
  calendar day (`src/lib/reports/capital-gains.ts:284-293`).
- [x] **H6** — the Investment Lots report consumes `lots.ts` instead of
  re-deriving basis (`src/app/api/reports/investment-lots/route.ts:107-110`).
- [x] **H8** — unpost writes a reversing transaction instead of deleting the
  posting.
- [x] **H9 (due-date half)** — aging reads the stored `trans-date-due` slot
  (`src/lib/business/business-reports.ts:637-648`).
- [x] **H10** — COGS posts by default on ship/fulfil
  (`src/lib/inventory-engine.ts:985-1011`).
- [x] **H11** — reconciliation is gated on an exact zero difference in the
  account's own commodity units, with a GnuCash-style Imbalance adjusting entry
  as the escape (`src/lib/reconcile.ts:359-379`).
- [x] **H13** — create-path validation errors are surfaced, and the form and
  API now validate the same submitted set.
- [x] **H14** — fixed-asset adjustments are computed against quantity
  (`src/lib/asset-transaction-service.ts:34-50`).
- [x] **ASI-6-005** — ledger filters are applied in SQL in the paging query, on
  both the global and per-account routes.

## P1 — Follow-ups raised by cross-review (2026-08-13/14)

These were raised by opposite-vendor reviewers while verifying the fixes above,
so each cites code we shipped. Verified against `5c5a555`. Two originally filed
here (`washsale-detector-transfer-exclusion`, `listparam-isabsent-centralization`)
were confirmed **already closed** and are omitted.

- [x] **Valued transfers delete the deferred gain.** Done 2026-08-19: `computeCarriedBasis` + `writeCarriedBasisSlot` on every own-account transfer with no value guard; `lots.ts` excludes the transfer-in's recorded value when `carriedBasis > 0`; `reconcileCarriedBasisForSourceLots` conserves slices across partial/out-of-order transfers; shared `isOwnAccountCommodityTransfer` (polly/valued-transfer-gain + polly/lot-scrub-fee-consistency).
- [x] **`lots.ts` reports gross while `capital-gains.ts` nets commissions.** **Partial 2026-08-19:** `getAccountLots({ includeTradeFees: true })` runs the same `loadTradeFees` allocator as the 8949 and nets fees into basis/proceeds; the Investment Lots report passes it and the ledger now books gains net of fees. Remaining: it is opt-in — `api/accounts/[guid]/lots/route.ts` and `api/reports/tax-harvesting/route.ts` still get gross figures. Make it the default or pass it there. **Effort:** S. — Done 2026-08-19: `getAccountLots` now nets by default (`includeTradeFees: false` is the gross escape hatch); both routes pass the book-scoped account-path map and surface fee warnings, and tax-harvesting was batched onto `getLotsForAccounts`.
- [x] **`trans-date-due` backfill.** Verified open 2026-08-19: `dunning.ts` still skips inferred due dates; no backfill script. **Effort:** M. — Done 2026-08-19: `src/lib/business/invoice-due-date-backfill.ts` recomputes the due date from bill terms via the post path's own `computeDueDate` and writes the missing slot; run as one-shot idempotent step `2026-08-19-invoice-trans-date-due-backfill` from `db-init.ts`.
- [x] **Portfolio surfaces present partial cost basis as complete.** Done 2026-08-19: `HoldingsTable.tsx` renders basis/gain only through `CostBasis`/`GainAmount`/`GainPercent` wrappers that require a `CostBasisCoverage` mark; dividends route withholds yield under partial coverage (polly/holdings-coverage-surfaces).
- [ ] **Short/oversold rows show a stale cost basis.** **Partial 2026-08-19:** pool removals clamp at held shares so an oversell drains basis to ~0 and coverage is nulled (no stale positive basis). Remaining: no short-position model; oversold rows show basis 0 / coverage unknown rather than a short basis. **Effort:** L.
- [ ] **Ledger UI ignores the coverage field.** Verified open 2026-08-19: `AccountLedger.tsx` row type still declares only `cost_basis`; coverage marks landed on holdings/portfolio/dividends, not ledger rows. **Effort:** S.
- [ ] **Email-ingest manual retry.** Verified open 2026-08-19 (descoped by design; `email-ingest.ts` header still documents the missing immutable owner column). **Effort:** L.
- [x] **No real-Postgres concurrency harness.** Done 2026-08-19: `vitest.integration.config.ts` + `src/__tests__/integration/` against the CI postgres:17 service; real lock tests — `trading-account-lock-order`, `account-lock-hierarchy-deadlock`, `account-rename-reparent-race`, `simplefin-create-race`, `simplefin-transaction-id-dedupe`, `lot-outflow-ordering` (polly/ci-integration-harness). Comment rot: `reconciled-split.service.test.ts:17` and `bulk-edit.test.ts:17` still carry the stale "no harness" disclaimer.
- [ ] **`reconciled-split.service.ts` guard lookups are not book-scoped.** Verified open 2026-08-19: zero `book` references in the module. **Effort:** M.
- [ ] **Inventory item accounts are nullable on save, required at post.** Verified open 2026-08-19: `inventory.service.ts` still writes nulls; `assertItemsPostable` rejects at fulfilment (now names all offenders, but still post-time). **Effort:** M.
- [ ] **Legacy average-cost fulfilments cannot post a COGS reversal.** Verified open 2026-08-19: `getShipmentWeightedUnitCost` returns null on any missing `unit_cost`; no backfill. **Effort:** M.
- [x] **Assets list and asset detail disagree.** Done 2026-08-19: `api/assets/fixed/route.ts` uses `getAssetBalances()` (sums quantity), the same helper as the detail view (polly/h14-asset-quantity).
- [x] **Four inline copies of the transfer predicate.** Done 2026-08-19: single exported `isOwnAccountCommodityTransfer` in `src/lib/account-transfer.ts`, consumed by `lot-scrub.ts`, `lot-assignment.ts`, `lots.ts`, `cost-basis.ts`.
- [ ] **Three copies of the depth-200 ancestor CTE.** Verified open 2026-08-19: `book-scope.ts`, `book-lock.ts`, `inventory-engine.ts`. **Effort:** S.
- [ ] **Reconcile adjustment tests never assert a shared `tx_guid`.** Verified open 2026-08-19: `reconcile.test.ts` adjustment test still asserts shape + `assertBalanced` only; only `scu = 100`. **Effort:** S.
- [ ] **Coverage epsilon is absolute, not magnitude-scaled.** Verified open 2026-08-19 (`commodities.ts` `qtyEpsilonForScu`, fails safe). **Effort:** S.
- [ ] **14 routes emit a generic `error: "Validation failed"` alongside specific `errors[]`.** **Partial 2026-08-19:** shared reader `src/lib/api-error.ts` added and the transactions create/update routes now set `error` to the joined summary (polly/h13-create-errors). Remaining: 13 routes still emit the generic string — auth/login, auth/register, auth/totp/{confirm,disable,recovery,verify}, commodities, exchange-rates, prices, prices/[guid], prices/audit, prices/fetch, user/profile. **Effort:** S.

## P2 — Form UI slop and accessibility

The forms are **better than expected**: zero `console.log`, zero `TODO`/`FIXME`,
zero `: any`, zero commented-out blocks across the entire form surface. Two
hypotheses were disproved — the TransactionForm family is *not* four duplicated
copies (one real editor, a thin modal wrapper, a misnamed read-only viewer, and
a row component; real drift is limited to `InlineEditRow` being a genuine second
editor), and `CreateBookWizard`/`NewBookWizard` are *not* duplicate wizards
(both delegate to the same `NewBookForm`). Genuine remaining slop:

- [ ] `CreateBookWizard.tsx` hand-rolls a *second* book-creation form hitting a **different endpoint** (`/api/books/from-template` vs `NewBookForm.tsx` → `/api/books/default`) with duplicated validation. Verified open 2026-08-19.
- [ ] **Seven** hand-rolled "read the server error body" implementations. **Partial 2026-08-19:** `src/lib/api-error.ts` (`extractErrorMessage`/`readErrorBody`/`throwErrorBody`) exists and is wired into `AccountLedger.tsx`, `WeekGrid.tsx`, `ContinuousCloseDashboard.tsx`. Remaining: `InvestmentTransactionForm.tsx` (~:577) and `AccountLedger.tsx:1421` still hand-roll; ~99 other `.error || '…'` readers across `src/components`.
- [ ] `InvestmentTransactionForm.tsx` — **write-only field** "Split Ratio (informational)", dead prop `accountCommodityGuid`, write-only state vars, dead `nameField` param. Verified open 2026-08-19 (only a11y commits touched the file).
- [x] `AccountPickerDialog.tsx` — no focus indicator. Done 2026-08-19: now `focus:border-primary focus:ring-2 focus:ring-primary` (polly/ui-focus-and-assets).
- [ ] `AccountForm.tsx`, `BudgetForm.tsx`, `LoginForm.tsx` — `rounded-xl`/`2xl` off `DESIGN.md`'s radius scale; three different input recipes across sibling forms. Verified open 2026-08-19.
- [ ] Native `title=` tooltips, **banned by `DESIGN.md`** — `InvestmentTransactionForm.tsx:645` ("Return of Capital" explanation only in a native tooltip), `:712`, and ~72 component files. Verified open 2026-08-19.
- [ ] `AccountLedger.tsx` — `☑`/`☐` text glyphs as checkbox chrome (no `aria-pressed`/`role="checkbox"`). Verified open 2026-08-19.
- [ ] `--error` and `--negative` are the same colour (`#dc2626` / dark `#f87171`) under two token names (`globals.css`). Verified open 2026-08-19.
- [ ] Server errors via toast, not inline, not announced. **Partial 2026-08-19:** `src/components/a11y/LiveRegion.tsx` (always-mounted `aria-live`) is wired into 25 components; `ToastContainer` has `aria-live="polite"`; `SplitRow`/`ReconciliationPanel` use `role="alert"` (polly/ui-a11y-remainder). Remaining: `TransactionForm.tsx` (~:1037) renders server/validation errors in a plain list with no live region; `AccountLedger` save failures still go to toast rather than inline on the field.

## P3 — CI and developer onboarding

- [x] **CI never runs typecheck.** DONE 2026-08-14. `typecheck` and
  `pretypecheck` (`prisma generate`) scripts added; the gate runs in the
  `quality` job ahead of `docs:check`, and `build-and-push` has `needs:
  quality`, so a type error blocks the image push and the production deploy.
- [x] **Document the Prisma prerequisite.** DONE 2026-08-14. `npx prisma
  generate` is in the README setup block, and `pretypecheck` re-runs it on
  every `npm run typecheck` so a developer who pulls a schema change cannot
  reproduce the phantom-error confusion locally.

**Still open in this area:**

- [ ] **CI has no `pull_request` trigger.** `.github/workflows/deploy.yml` fires on `push: branches: [main]` only. Verified open 2026-08-19. Note: main is currently gated by the local-CI workflow (`[skip ci]` pushes after a full WSL reproduction of the quality job) to conserve Actions minutes.
- [ ] **`npm run build` is not in the `quality` job.** Verified open 2026-08-19: quality = typecheck, docs:check, test:run, integration schema+tests, deadlock oracle, lint; build only in the Docker step.
- [ ] **The Playwright E2E suite runs nowhere.** Verified open 2026-08-19: no `test:e2e` script, no CI step.
- [x] **No real-Postgres test harness.** Done 2026-08-19: quality job runs a `postgres:17-alpine` service with `TEST_DATABASE_URL`, `test:integration:schema`, `test:integration`, and the Prisma deadlock oracle (polly/ci-integration-harness). Duplicate of the data-integrity item above.
- [ ] **`test:coverage` exists but CI never invokes it**, so there is no coverage threshold. Verified open 2026-08-19.
