# TODOS

Items deferred from plan reviews for future implementation.

## P1 - BUG: Multi-Lot Transfers Create Single Destination Lot

**What:** When shares transfer between accounts and the source has multiple lots, the auto-scrub engine creates one destination lot for the entire transfer-in split instead of splitting it across destination lots matching each source lot.

**Repro:** Account `56900f1b19ac4545b0f6d9bbca66feb2` (Ally VOO). On 2023-07-05, 591 shares transferred from Schwab VOO (`ca45b0d68fb442f293dd6e1d98c00e98`). The source had 4 lots:
- Lot `f8c1a42a`: 534 shares (acquired 2021-04-06)
- Lot `31c7a186`: 33 shares
- Lot `926ae7f4`: 13.89 shares
- Lot `b741b060`: 10.11 shares

The auto-scrub created one destination lot (`f0040f5a`) for all 591 shares, pointing only to the largest source lot. Cost basis is $0 (transfer), and the other 3 source lots' acquisition dates are lost.

**Expected behavior:** The 591-share transfer-in split should be sub-split into 4 destination splits (534, 33, 13.89, 10.11), each assigned to its own destination lot linked to the corresponding source lot via `source_lot_guid`. Each destination lot should carry the correct `acquisition_date` from its source lot. This preserves the full lot chain for long-term/short-term capital gains classification.

**Root cause:** `linkTransferToLot()` in `lot-assignment.ts` creates one lot per transfer-in split. It doesn't examine whether the source account's transfer-out consists of multiple lots and sub-split accordingly. The transfer-out side already has sub-splits per lot (visible in the transaction: -534, -33, -13.89, -10.11), but the transfer-in side is one lumped split (+591).

**Fix approach:**
1. In the transfer detection phase, after identifying a transfer-in, examine the source transaction's transfer-out splits
2. If the source has multiple lot-assigned splits, sub-split the transfer-in to match (proportional by quantity)
3. Create one destination lot per sub-split, each linked to the corresponding source lot
4. Carry `acquisition_date` from each source lot to its destination lot
5. This is essentially the same "sell splitting" logic (`splitSellAcrossLots`) but applied to transfers

**Effort:** M (human: ~1 week) / with CC: S (~30 min)

**Depends on:** Lot auto-assignment engine (shipped). The `splitSellAcrossLots()` function in `lot-scrub.ts` provides the pattern for sub-splitting.

**Context:** Discovered during QA of VOO account 2026-03-24. The design doc (`2026-03-22-lot-scrub-engine.md`) already identified "Transfers break lot continuity" as a known gap. This is the concrete manifestation of that gap with a real-world repro case.

---

## P2 - Monte Carlo FIRE Projections

**What:** Replace the single-line FIRE projection with a Monte Carlo simulation that samples from historical market return distributions. Show confidence bands (e.g., 10th/25th/50th/75th/90th percentile outcomes) instead of a single deterministic line.

**Why:** The current FIRE projection uses a single expected return rate (default 7%), which gives a false sense of precision. Real markets are volatile — a Monte Carlo approach using historical annual return distributions would show the range of possible outcomes: "you have a 75% chance of reaching FI by 2038, but a 25% chance it takes until 2042."

**Effort:** M (human: ~1 week) / with CC: M (~30 min)

**Depends on:** FIRE calculator data-driven upgrade (shipped). Needs a historical return dataset (e.g., S&P 500 annual returns 1928-present) either embedded or fetched.

**Context:** Deferred from QA review 2026-03-22. The single-year TWR (20.92%) was being used as the default expected return, which was wildly optimistic. Fixed to default to 7%. Monte Carlo would make the projection genuinely useful for planning by showing probability distributions instead of point estimates. Consider: Shiller CAPE data, sequence-of-returns risk modeling, and configurable asset allocation (stocks/bonds mix affects return distribution).

---

## P2 - Scheduled Transactions: Execute/Skip Upcoming Occurrences

**What:** Add the ability to execute or skip upcoming scheduled transaction occurrences from the web UI. Executing creates the actual GnuCash transaction (with splits matching the template), skipping advances `last_occur` and decrements `rem_occur` without creating a transaction.

**Why:** The scheduled transactions page is currently read-only — you can see what's coming but can't act on it. The most valuable action is executing upcoming payments (salary, mortgage) directly from the web app instead of opening GnuCash desktop. This is the core use case mentioned in the original feature brief.

**Effort:** M (human: ~1 week) / with CC: S (~30 min)

**Depends on:** Scheduled transactions UI (shipped). Requires write access to GnuCash tables: `transactions`, `splits`, `schedxactions` (updating `last_occur`, `rem_occur`, `instance_count`).

**Context:** Deferred from initial scheduled transactions implementation (2026-03-22). The template resolution logic already exists in the API — executing means creating a real transaction from the resolved template amounts and account mappings, then updating the schedxaction metadata. Need to handle: transaction date (use occurrence date vs today), multi-split transactions, and GnuCash GUID generation for new transactions.

---

## P2 - Scheduled Transactions: Enable/Disable

**What:** Toggle scheduled transactions on/off from the web UI. Updates the `enabled` field (0/1) on the `schedxactions` table.

**Why:** Simple quality-of-life feature — disable a scheduled transaction that's no longer relevant (e.g., old subscription) without opening GnuCash desktop. The UI already shows enabled/disabled badges.

**Effort:** S (human: ~2 days) / with CC: S (~10 min)

**Depends on:** Scheduled transactions UI (shipped). Single field update on `schedxactions.enabled`.

**Context:** Deferred from initial implementation. Trivial write operation — PATCH endpoint + toggle button in the UI. Low risk since it only flips a boolean flag.

---

## P3 - Scheduled Transactions: Create New

**What:** Create new scheduled transactions from the web UI with recurrence pattern configuration. Particularly useful for salary deposits and mortgage payments — the mortgage calculator could auto-generate a scheduled transaction matching the amortization schedule.

**Why:** Currently scheduled transactions can only be created in GnuCash desktop. For users who primarily use the web app (the goal of this project), being able to set up recurring salary and mortgage payments without desktop access completes the workflow. The mortgage payoff calculator already knows the payment amount, accounts, and frequency.

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** Scheduled transactions UI (shipped), execute/skip feature (for testing the created transactions). Requires writing to: `schedxactions`, `recurrences`, template `accounts`, template `transactions`/`splits`, and `slots` (for account GUID mapping).

**Context:** Deferred from initial implementation. This is the most complex scheduled transaction write operation because it requires creating the full GnuCash template structure (template root account → child template accounts → template transaction with splits → slots mapping template accounts to real accounts). The mortgage calculator integration (auto-creating a scheduled transaction from payoff parameters) would be a natural follow-up.

---

## P2 - Payslip Integration (PDF + QuickBooks Online)

**What:** Import payroll stubs into GnuCash Web. Phase 1: PDF upload + AI extraction into structured line items, mapped to GnuCash accounts via reusable per-employer templates, posted as detailed split transactions. Phase 2: QuickBooks Online API as an optional structured data source (OAuth 2.0 + Intuit Payroll API).

**Why:** Paychecks currently import via SimpleFin as lump-sum deposits with no breakdown. Users who want to track taxes, deductions, and retirement contributions must manually create split transactions. This automates that workflow and stores payslip PDFs alongside receipts.

**Effort:** L (human: ~2-3 weeks) / with CC: M-L (~1-2 hours)

**Depends on:** Receipt storage infrastructure (shipped), AI extraction pipeline (shipped), BullMQ queue (shipped).

**Spec:** [`docs/superpowers/specs/2026-03-24-payslip-integration-design.md`](docs/superpowers/specs/2026-03-24-payslip-integration-design.md)

**Context:** Designed 2026-03-24. Phase 1 (PDF + AI) builds on existing receipt/OCR infrastructure. Phase 2 (QBO API) deferred — requires Intuit developer approval and paid QuickBooks Payroll subscription. Key features: per-employer account mapping templates, SimpleFin deposit enrichment/dedup, balance validation with imbalance account fallback, employer contribution tracking (informational only).

---

## P4 - Receipt AI Re-Extraction Batch Job

**What:** A "Re-extract all" button in AI settings that enqueues BullMQ jobs to re-run extraction on all existing receipts that used regex, using the newly configured AI provider.

**Why:** When a user configures AI for the first time, their existing receipts have `extraction_method: "regex"`. Re-extraction with AI would improve match quality for the backlog without requiring re-upload.

**Effort:** S (human: ~2 days) / with CC: S (~10 min)

**Depends on:** Receipt auto-matching feature with AI provider configuration.

**Context:** Deferred from eng review 2026-03-22. Users get AI extraction on new uploads immediately. The batch re-extraction is a nice-to-have that adds batch job management complexity. Users can also manually trigger re-extraction per receipt.
