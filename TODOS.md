# Product Roadmap and TODOs

Updated 2026-09-29. This file holds **open work only**. Shipped, cancelled, and
superseded items, with their design notes and evidence, are in
[docs/roadmap-archive.md](docs/roadmap-archive.md); release history is in
[CHANGELOG.md](CHANGELOG.md). When an item ships, record it in the changelog and
delete it here. Do not leave "Implemented" entries behind.

## Finding items

Every item uses the same shape, so a plain text search finds it:

```markdown
### [P#] Short descriptive title

**Status:** <status> · **Area:** <area> · **Added:** YYYY-MM-DD · **Effort:** S|M|L
**Keywords:** words someone would search for, including synonyms

**Outcome:** what is true for the user when it is done.
...details, dependencies, and acceptance notes...
```

- `grep -n '^### \[P[0-4]' TODOS.md` lists every item with its priority.
- `grep -n 'Status:\*\* Open' TODOS.md` lists the ready work. Status values are
  **Open** (ready to build), **Blocked** (waiting on something external),
  **Deferred** (deliberately not now, with the reason), and **Cancelled**
  (will not be built, kept one release so the decision is visible).
- Areas: `planning`, `tax`, `investments`, `ledger`, `business`, `documents`,
  `utilities`, `integrations`, `platform`.

## Priorities

| Priority | Meaning |
|---|---|
| **P0** | Product foundation or data-integrity defect; do first |
| **P1** | Next major workflow or correctness requirement |
| **P2** | Valuable feature pack built on the shared foundations |
| **P3** | Targeted expansion or connector |
| **P4** | Nice-to-have, cleanup, or low-frequency operation |

## Product rules

Every new feature should satisfy these rules:

- **No orphan tools.** New capabilities feed at least one shared surface:
  Action Center, Money Timeline, Living Plan, or Financial Provenance.
- **Deterministic before generative.** Calculations, ranking, and mutations use
  typed domain logic. AI may explain, normalize, or suggest; it does not invent
  figures or write unrestricted SQL.
- **Preview, approve, undo.** Material changes show their balanced transaction
  or configuration diff before execution and leave an audit record.
- **Evidence is part of the result.** Recommendations cite source transactions,
  documents, prices, FX rates, rules, assumptions, and confidence.
- **Book-aware by default.** Services declare whether they work on one book,
  linked books, or a consolidated household/entity graph.
- **Close loops.** Prefer observation → decision → action → reconciliation over
  another passive report.

## Admission checklist

Before adding a feature, answer:

1. What user decision or recurring workflow does it improve?
2. Does it emit an Action, Timeline event, Plan input, or evidence trace?
3. What existing engine or data does it reuse?
4. What calculation is deterministic and testable?
5. What is the preview/approval/undo behavior?
6. Is it single-book or cross-book, and how are currencies handled?
7. What measurable outcome proves it was useful?

If those answers are weak, improve an existing workflow instead.

---

# Open

### [P1] Effective-dated entity and tax classification history

**Status:** Open · **Area:** tax · **Added:** 2026-09-29 · **Effort:** L
**Keywords:** entity type, tax classification, S election, Form 2553, Form
8832, check-the-box, disregarded entity, S-corp effective date, entity
history, legal form, tax status, conversion, as-of date, prior year

**Outcome:** Each book keeps a dated history of its legal form and its federal
tax classification. Every tax-sensitive feature asks "what was this entity on
date X / for tax year Y?" instead of reading today's value. For example, if
Lotus Bud elects S-corp status effective 2027-01-01, the 2026 reports,
Schedule C, and expense reports still treat it as a disregarded single-member
LLC, while 2027 treats it as an S-corp. Recording the election in advance
(effective next January 1) drives reminders without changing current
behavior.

**Today:** `gnucash_web_entity_profiles` has one row per book (`entity_type`,
`business_activity`, `filing_status`, ...), with no effective dates and no
history. Editing it silently rewrites the treatment of every prior year.
`entity_type` also mixes two separate facts. `llc_single` and `s_corp` are
different kinds of thing: an LLC with an S election is legally an LLC and is
taxed as an S-corp. About 50 modules in `src/lib` and `src/app/api` read
entity type, among them compliance, book features, linked-business 1040
aggregation, the S-corp and retirement analyzers, the Money Timeline, and the
990 and Schedule F routes.

**Model:**

- Separate **legal form** (`sole_prop`, `llc_single_member`,
  `llc_multi_member`, `corporation`, `nonprofit_corp`, `household`) from
  **tax classification** (`individual_1040`, `disregarded_schedule_c`,
  `disregarded_schedule_f`, `partnership_1065`, `s_corp_1120s`, `c_corp_1120`,
  `exempt_990`). Validate the pairs: a sole prop cannot be `s_corp_1120s`,
  and a multi-member LLC cannot be disregarded.
- New table `gnucash_web_entity_status_history` with these columns: book guid,
  `effective_from` (date), legal form, tax classification, election form
  (`2553` / `8832` / none), filed date, IRS acceptance date, linked documents
  (the election and the CP261 acceptance letter in the Document Vault),
  notes, and created by/at. Ranges must not overlap. A row is effective until
  the next row begins. Future-dated rows are allowed and marked **planned**
  until acceptance is recorded.
- `entity_type` on the profile becomes a derived "current" value, kept for
  compatibility and for non-tax gating such as feature-module defaults and
  the chart template.

**API:** add `getEntityStatusAt(bookGuid, date)` and
`getEntityStatusForTaxYear(bookGuid, year)`. The tax-year form returns every
segment when an effective date falls mid-year. That is a short-year case:
v1 warns and asks the user to confirm the split, and never guesses.

**Migrate the consumers**, starting with those that depend on tax years:

- Compliance calendar and reminders: which return is due, and when (1120-S
  on March 15 vs. Schedule C on April 15), plus a Form 2553 deadline item for
  a planned election. The deadline is 2 months and 15 days after the start
  of the tax year.
- Linked-business 1040 aggregation (`src/lib/tax/linked-business.ts`): a
  Schedule C profit year vs. a K-1 plus W-2 year.
- Estimated taxes and self-employment tax, the S-corp analyzer (compare
  before and after using the real effective date), and retirement capacity
  (SE income vs. W-2 wages).
- Owner expense reports: the accountable-plan guard is evaluated at each
  line's expense date.
- Reports and exports run for a past period show the status in effect for
  that period, with a banner when the period spans a change.

**UI:** the entity settings show a timeline. Changing the type asks whether
the user is recording a change effective on a date, or correcting a mistake
in an existing row. A correction rewrites history and is audited, with a
preview of which tax years' outputs change. Show a new entity's status "since
inception" by default. Seed each existing book with one row effective from
its first transaction date.

**Surfaces:** the Action Center gets "S election effective 2027-01-01: set up
payroll and reasonable compensation", "Form 2553 due by 2027-03-15", and
"Election filed, IRS acceptance not recorded". The Money Timeline gets the
effective date and the filing deadlines. Tax outputs cite the status row
they used.

**Acceptance:**

- Record a planned S election for Lotus Bud effective next January 1.
- The current-year Schedule C, estimated taxes, and expense-report guard do
  not change, and the compliance calendar gains the 2553 and 1120-S items.
- Moving the "as of" date past January 1 switches every migrated consumer.
- Correcting a historical row shows the tax years it affects before saving,
  and leaves an audit record.

### [P2] Contractor portal: payment history and details

**Status:** Open · **Area:** business · **Added:** 2026-09-29 · **Effort:** M
**Keywords:** contractor portal, vendor portal, self-service, payment history,
remittance, vendor access, invoice, job, work period, 1099, W-9, share link

**Outcome:** A company using Folio can invite a contractor to view only that
contractor's payments from its books. Show the payer, amount, payment date,
status, method/reference, related invoice, job, or work period, and any receipt
or remittance recorded by the company. Link each payment to its Folio
transaction, flag missing or unmatched details for the company in the Action
Center, and show payment dates in the Money Timeline.

**Access and security (the main design question):** the contractor is an
outside party with no Folio account. Start from the customer share-link model
in `src/lib/business/invoice-shares.service.ts` (`/share/invoice/[token]`):
random 24-byte tokens, revocable and expiring, resolved without a session, and
indistinguishable from unknown tokens once revoked. Decide whether a bare link
is enough for a standing, multi-payment view or whether it needs a second
factor (emailed one-time code). Either way:

- Scope every query to one vendor in one book. A token must never widen to the
  vendor's other books, other vendors, or any account or transaction detail
  beyond the payment row itself.
- Show payer-side facts only: no account names, balances, or splits other than
  the payment amount and reference.
- Invite, revoke, and view events go to the audit log; the company can see when
  a contractor last opened the portal.

**Reuse, don't rebuild:**

- Invoice share links and the client portal (`src/app/share/`, shipped
  2026-07-24) for token issue/revoke, the public read-only rendering, and the
  expired-link screen.
- 1099 Contractor Compliance (`vendor-1099.service.ts`,
  `vendor-1099-compliance.ts`) for the vendor record, W-9 status, and which
  payments count toward the 1099-NEC total. The portal can show the contractor
  their year-to-date 1099 amount and request a missing W-9.
- Receipt/document evidence links for remittance attachments.

### [P2] Owner expense reports: personal-card spend reimbursed by a linked business

**Status:** Open · **Area:** business · **Added:** 2026-09-29 · **Effort:** L
**Keywords:** expense report, reimbursement, reimbursable, owner reimbursement,
accountable plan, due to owner, due from business, personal credit card,
business expense, cross-book, linked books, book links, expense voucher,
employee, owner contribution, capital contribution, interbook

**Outcome:** An owner who pays business expenses on a personal card can select
those charges in the household book, bundle them into an expense report for
the linked business book, and have the business approve and reimburse it.
Approval writes the expense into the business book. Payment clears the
personal receivable in the household book. Both sides stay linked, so each
charge shows its state (unreported, reported, approved, paid) and nothing is
booked twice or dropped.

**Why now (prod, 2026-09-29):** Crawford Home already codes Lotus Bud
Acupuncture spend to
`Assets:Account Receivable:Reimbursable:Lotus Bud Acupuncture`. There are 29
charges since 2026-03-01 totaling $2,091.21, mostly on the Fidelity Rewards
and Cara Chase Amazon Prime cards, and none has been reimbursed. The books are
already linked in `gnucash_web_book_links` (Lotus Bud is `owned_business`,
100%). But the Lotus Bud book has no employees, and `employees` is not enabled
in its book features. The business-side Reimbursements queue has never been
used. Today the only route is to re-key every charge as a voucher in Lotus Bud
by hand, with nothing tying it back to the personal transaction.

**What exists, and the gap:**

- Employees & Vouchers (`src/lib/business/vouchers.ts`, `employees.service.ts`)
  and the reimbursement queue (`src/lib/business/reimbursements.ts`, with
  submit → approve → draft `REIMB-<id>` voucher → post → pay). This is single
  book, one line per request, and it starts from a business-book receipt.
- Book links (`src/lib/services/book-links.service.ts`) are entity level only
  ("NOT transaction mirroring").
- Interbook eliminations (`src/lib/family-office/service.ts`) match cash
  transfers between books, but only for consolidated reports.
- Cross-book writes are blocked on purpose. No single transaction may span two
  books, and this feature must keep that rule. It writes **two independent
  balanced transactions**, one per book, and connects them in a link table.

**Workflow:**

1. **Configure** (per book link): the household "reimbursable" receivable
   account; the business employee record for the owner (offer to auto-create
   it and enable `employees`); a default business expense account; and the
   settlement mode (see below).
2. **Pick** (household book): an "Expense report" picker lists the
   unreported splits in the reimbursable account. Show date, payee, card, and
   amount, with attached receipts/documents. A row or bulk action, "Mark for
   reimbursement → Lotus Bud", also recodes a split from an ordinary expense
   account into the receivable, so marking and recoding are one step.
   - **Split a charge across reports:** a line can claim only part of a
     charge, as an amount or a percent. The rest stays available for a later
     report, which can target a different linked business book. Or the user
     can mark the rest as personal, which recodes that portion to a household
     expense account.
   - The picker shows the **unallocated remainder** of each charge, not its
     original amount, and hides a charge once it is fully allocated.
   - Whenever a split changes the household ledger, preview the rewritten
     household transaction before saving. Take a $62.22 card charge split as
     $40.00 business and $22.22 personal: the receivable split becomes $40.00
     and a new $22.22 split goes to `Expenses:Dining`. Portions headed to
     different business books go to per-book receivable subaccounts
     (`Reimbursable:Lotus Bud`, `Reimbursable:<other>`). Portions on two
     reports for the same book need no ledger change; only the allocation
     rows differ.
3. **Submit:** create a multi-line report and carry receipts across as
   document links. The submitter does not need to know the business chart of
   accounts. Each line lands in the business book's Reimbursements queue as a
   draft voucher entry. It is **uncategorized** (a configurable default such
   as `Expenses:Uncategorized`) unless a rule already matches.
4. **Categorize** (business book): lines on one report go to different
   expense accounts. For example, Google Workspace goes to Software &
   Subscriptions, Golden Needle and Silverliningherbs go to Supplies, and
   Protrainings CPR goes to Continuing Education. Give the report a
   categorization grid:
   - Pre-fill each line from the business book's categorization rules
     (`applyRules` in `src/lib/services/categorization.service.ts`), then from
     that book's payee history. Show which rule or history match made each
     suggestion.
   - Let the user pick an account per line, bulk-assign to selected lines,
     and split one line across several accounts (for example, one Amazon
     order with a book and TENS pads).
   - Offer "Remember for this payee" to create a rule in the business book,
     so the next report arrives already categorized. Suggest rules from the
     report's history with `suggestRules`.
   - The household book's account, `Reimbursable:Lotus Bud`, carries no
     category information, so never copy it across. The business chart is
     the only source of categories.
   - Raise an Action Center item for "N reimbursement lines uncategorized".
5. **Approve** (business book, needs edit permission there): you cannot
   approve while any line is still in the uncategorized default. Preview one
   voucher with one entry per categorized line, then post it to A/P under the
   owner employee. The result is debit expenses by category, credit A/P (due
   to owner).
   - **Recategorize after posting:** a posted voucher's splits must match its
     entries. Changing a line's category therefore runs unpost → edit entry →
     repost as one audited, previewed operation. Block it once the voucher is
     paid, or once its period is closed. Do not edit the ledger splits
     directly.
6. **Pay:** use `payVouchers` from business checking. Then offer the matching
   household transaction for approval: debit personal checking, credit the
   reimbursable receivable. If a SimpleFIN-imported deposit already exists,
   match it instead. Record the pair as an approved interbook elimination.
7. **Settlement mode alternative** (single-member LLC): "Treat as capital
   contribution" instead of repaying. The business side is debit expenses,
   credit `Equity:Owner's Contributions`. The household side reclasses the
   receivable to the owner's investment in the business (Crawford Home already
   has `Equity:Lotus Bud Acupuncture`). No cash moves. Step 4 applies here
   too: the lines are categorized before anything posts.
   - **Entity-type guard:** this mode is tax-neutral only for a disregarded
     entity (`llc_single`, `sole_prop`). Business expenses are deductible on
     Schedule C whoever paid them, and draws are never taxed separately. For
     an S-corp (an `s_corp` entity type, or an LLC with an S election), or a
     C-corp, an owner-employee's personally paid expenses are deductible only
     if the business reimburses them under an **accountable plan**
     (substantiation, business purpose, timely submission and return of any
     excess). Since TCJA, unreimbursed employee expenses are not deductible
     by the employee. For those entity types:
     - Hide or warn on "Treat as capital contribution". Explain that it
       forfeits the deduction.
     - Default to reimbursement.
     - Enforce accountable-plan evidence on every line: receipt attached,
       business-purpose memo, and a configurable submission deadline (for
       example, 60 days from the expense date).
     - Flag lines past the deadline in the Action Center. Late lines may
       need to be treated as taxable wages.
     - Evaluate each line against the tax status **in effect on its
       expense date**, not today's status. See "Effective-dated entity and tax
       classification history" below. A report that spans an S election's
       effective date applies different rules to its lines before and after
       that date. Show the resolved status per line, and show the next
       planned change on the book-link settings.
     - Link the report to the S-corp analyzer's household context. The
       analyzer uses book links today.

**Data:** add `report_id` and per-line rows (with `source_book_guid`,
`source_split_guid`, `target_voucher_entry_guid`, `expense_account_guid`,
and `categorized_by`, which is rule id, history, or manual) to the reimbursement
tables, or add a new `gnucash_web_expense_reports` / `_lines` pair. The
current `reimbursement_requests` row is one line per receipt. Each line
stores an allocated `amount` and `source_split_guid`, so one charge can feed
several lines across reports. A unique index cannot enforce the invariant: the
sum of amounts over non-rejected lines for a source split must be at most that
split's value. Enforce it in the write path under an advisory lock keyed on
the source split. Record the portion marked personal as its own allocation
row, of kind `personal`, so the remainder math is explicit and auditable.

**Drift and guardrails:**

- Warn and flag in the Action Center if a reported source split is edited,
  deleted, or re-amounted, or if a posted voucher is unposted. Also flag it
  if a source split is re-amounted below the sum already allocated from it.
- Reconciliation check: the household reimbursable balance must equal
  unreported lines + the business A/P (owner) balance for the linked book. A
  mismatch raises an Action.
- Block the report on currency mismatch in v1. Both books are USD today.
- Permission: the submitter needs edit on the household book. The approver
  needs edit on the business book. Each side is audit logged.

**Surfaces:** Action Center ("$2,091 of Lotus Bud expenses not yet
reported", "Report ER-3 awaiting approval", "Report ER-3 approved, unpaid"),
Money Timeline (the expected reimbursement date), and a status badge on the
household ledger row. A fully reported charge shows
`Reported · ER-3 · Paid 2026-10-05`. A partly reported one shows
`$40.00 of $62.22 on ER-3 · $22.22 personal`.

**Acceptance:** backfill the existing 29 Crawford Home charges into one
report. Categorize it in Lotus Bud across at least three expense accounts,
saving payee rules as you go, and include one split line. Leave one charge
partly allocated and finish it on a second report. Split another charge
between business and personal, and confirm that the household transaction was
rewritten and still balances. Then approve and pay
it. A second report containing a repeat payee (Google Workspace, Golden
Needle) must arrive already categorized by those rules. Confirm that the household
reimbursable account nets to zero, that Lotus Bud's P&L shows the expenses by
category, that the consolidated view eliminates the payment, and that
re-running the picker offers none of those charges again.

### [P3] Home Assistant energy integration: billed vs. metered usage

**Status:** Open · **Area:** utilities · **Added:** 2026-08-11 · **Effort:** M
**Keywords:** home assistant, HA, emporia vue, kWh, electric bill, meter,
energy monitor, utility bill cross-check, solar sizing

**Outcome:** Every imported electric bill is cross-checked against what the
house actually metered. The utility's billed kWh sits beside Home Assistant's
measured consumption for the same service period, and the difference is
surfaced, so a meter-vs-monitor discrepancy, an estimated read, or a billing
error becomes visible.

**Environment (verified 2026-08-11 against the live HA instance on truenas,
container `homeassistant`, config `/mnt/docker/volumes/hass`):**

- Whole-home monitoring is an Emporia Vue 2. The energy dashboard's grid source
  is `sensor.vue2_total_daily_energy`, plus ~15 per-circuit device sensors (AC,
  dryer, furnace, garage, kitchen, …) in `.storage/energy`. Configured flat
  price: $0.119/kWh.
- Long-term statistics live in the recorder's TimescaleDB (Postgres at
  192.168.5.21:5432/homeassistant), tables `statistics` + `statistics_meta`.
  The grid sensor has hourly rows from 2023-03-13 onward (~26k rows). Unit is
  **Wh**, not kWh. Period usage = `max(sum) − min(sum)` over the window (`sum`
  is cumulative and survives counter resets).
- The HA container is on `iot_macvlan` (own IP); the API is reachable with a
  long-lived access token.

**Scope:**

1. **Connector** following the Fuel Tracker pattern: per-book encrypted
   settings (HA base URL, long-lived token, chosen grid/gas statistic ids), a
   BullMQ sync job, incremental fetch keyed on period start. Use the WebSocket
   API's `recorder/statistics_during_period` (hourly/daily sums). REST
   `/api/history/period` is unsuited to multi-year ranges; a direct TimescaleDB
   read is the documented fallback, not the contract.
2. **Bill cross-check:** for each utility bill with a parsed service period,
   show billed vs. metered kWh with delta and percent. Deviations beyond a
   tolerance become Action Center items with the calculation trace; matched
   bills carry the metered figure as evidence.
3. **Period breakdown:** per-circuit consumption for the bill period ("the AC
   was 41% of this bill") in the existing charge-breakdown UI, not a new page.
4. **Solar scenario upgrade:** the actual hourly consumption profile replaces
   the flat annual-production assumption when sizing solar.

**Checklist:** improves the monthly bill-review workflow (measure: bills with a
metered cross-check, discrepancy dollars surfaced). Emits Action Center items
and evidence on existing bills. Deterministic sum-difference; no AI. Preview and
undo come from the bill review queue. Single-book. Depends on the
`src/lib/resilience/` utilities section, receipt evidence links, connection
settings, and the BullMQ worker.

### [P3] Verify TXF code `N304` for Traditional IRA contributions

**Status:** Open · **Area:** tax · **Added:** 2026-08-12 · **Effort:** XS
**Keywords:** TXF, TurboTax export, N304, traditional IRA, Schedule 1 line 20,
Schedule C line 24b

**Outcome:** The TXF export uses a confirmed code for Traditional IRA
deductions. `txf-codes.ts` documents `N304` as Schedule 1 line 20, but it may
collide with Schedule C line 24b. Confirm against an authoritative TXF
reference, then either close this or fix `txf.ts` / `txf-codes.ts` with a test.

---

# Blocked

### [P3] Payslip: QuickBooks Online / Intuit Payroll connector

**Status:** Blocked (needs Intuit developer approval and product access) ·
**Area:** integrations · **Added:** 2026-03-24 · **Effort:** M–L
**Keywords:** payslip, paystub, payroll, QuickBooks Online, QBO, Intuit
Payroll, connector

**Outcome:** Payslips arrive as structured data from the payroll provider
instead of PDF/AI extraction. PDF/AI extraction and employer templates are
already shipped. The connector must preserve SimpleFIN deposit enrichment,
dedupe, balanced posting, and employer contribution metadata.

**Design:** `docs/superpowers/specs/2026-03-24-payslip-integration-design.md`

---

# Deferred

### [P2] TXF export of realized capital gains

**Status:** Deferred (reopen only with a verified TXF reference) ·
**Area:** tax · **Added:** 2026-08-12 · **Effort:** M
**Keywords:** TXF, TurboTax, capital gains, Schedule D, Form 8949, N683, N684

The TXF export omits realized capital gains; Form 8949 is emitted separately. A
Schedule D/TXF path was added and then reverted (`ff3d01f5`) because TurboTax
double-counted `N683`/`N684` (imported 16,800 against a true 8,400).

### [P3] Qualifying-farmer flag in the estimated-tax tracker

**Status:** Deferred (only if the tracker gains a farm-book mode) ·
**Area:** tax · **Added:** 2026-08-12 · **Effort:** S
**Keywords:** estimated tax, qualifying farmer, 66⅔%, §6654(i), farm

`api/tax/estimated/route.ts` hardcodes `isQualifyingFarmer: false`. `ff3d01f5`
removed the unreachable election from the household-only tracker; the
`withholding.ts` support for the farmer safe harbor remains.

### [P4] Document Vault: semantic search (RAG) over document text

**Status:** Deferred (measure full-text search and auto-tagging first) ·
**Area:** documents · **Added:** 2026-08-13 · **Effort:** L, unscoped
**Keywords:** RAG, embeddings, pgvector, semantic search, document Q&A, vault

**Outcome:** Grounded question-answering across the archive ("what's my
deductible on the barn policy?") where Postgres full-text search's exact-token
matching falls short. Vault v1 (auto-tagging, in-vault search, preview cards)
shipped 2026-08-20.

When it is picked up:

- Chunk and embed in the existing extraction worker, keyed off
  `gnucash_web_documents.extracted_text`, so there is one canonical text of
  record. Do not create a second document store.
- Prefer `pgvector` in the existing Postgres over an external vector service.
- **Book scoping and RBAC must hold at retrieval time.** An index that ignores
  `book_guid` leaks documents across books; this is the largest risk.
- Retrieval is hybrid (FTS + vector) and cites the source document and page.
  Any dollar amount in an answer must trace to a document.
- Size re-embedding on document change and per-upload embedding cost first.

---

# Cancelled

### [P3] Scheduled book sync to external PostgreSQL / GnuCash Desktop

**Status:** Cancelled 2026-09-29 (will not implement) · **Area:** integrations
**Keywords:** book sync, export to GnuCash Desktop, external PostgreSQL,
replication

Proposed a scheduled export of one web book into a vanilla GnuCash-compatible
PostgreSQL database with incremental sync and conflict detection. Dropped by
decision; full proposal in the archive.
