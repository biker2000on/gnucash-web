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
