# TODOS

Items deferred from plan reviews for future implementation.

## P2 - Tax Harvesting Dashboard

**What:** A view showing open lots with unrealized losses, sorted by loss magnitude, with ST/LT classification and wash sale warning window (30 days before/after).

**Why:** Tax-loss harvesting is the primary advanced use case for lot tracking. Without it, the lot infrastructure serves curiosity but not actionable tax planning.

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** Lot viewer, lot gains calculation, per-account cost basis method (all in feat/investment-support)

**Context:** Deferred from CEO plan review 2026-03-18. The lot infrastructure needs to be proven solid before building the harvesting dashboard on top. Wash sale detection (30-day window check) adds complexity. Tax rate assumptions vary by jurisdiction — may need a configurable rate.

---

## P3 - Lot Assignment UI (Manual Split-to-Lot Linking)

**What:** A UI for manually assigning unlinked splits to lots, equivalent to GnuCash desktop's Lots Editor >> / << buttons. Enables specific identification cost basis method.

**Why:** Some users need to choose which specific shares to sell for tax optimization. Without this, specific identification is impossible — only FIFO/LIFO/average are available.

**Effort:** M (human: ~1 week) / with CC: S (~30 min)

**Depends on:** Lot viewer (in feat/investment-support)

**Context:** Deferred from CEO plan review 2026-03-18. This is a write operation that modifies the GnuCash database (updating `lot_guid` on splits, creating/deleting lots). Higher risk than the read-only lot features. Should include validation that lot share balances remain consistent.

---

## P3 - Receipt Full-Text Search (tsvector + GIN)

**What:** Migrate receipt OCR search from `ILIKE '%query%'` to PostgreSQL full-text search with a `tsvector` column and GIN index on `gnucash_web_receipts`.

**Why:** `ILIKE` is a sequential scan that degrades at scale. At ~1000+ receipts with large OCR text blobs, search becomes noticeably slow (seconds). Full-text search with GIN index gives sub-second results at any scale, plus supports ranking, stemming, and partial matches.

**Effort:** S (human: ~2 days) / with CC: S (~15 min)

**Depends on:** Receipts feature shipped with ILIKE search working.

**Context:** Deferred from eng review 2026-03-21. The initial ILIKE implementation is fine for launch and early usage. Upgrade when receipt count exceeds ~1000 or search latency becomes noticeable. Requires: adding `ocr_tsvector tsvector` column, a trigger to populate on INSERT/UPDATE, and a GIN index. Search query changes from `ILIKE` to `@@` operator.

---

## P3 - Receipt Auto-Matching (Approach C)

**What:** Upload receipts without a transaction link, OCR extracts amount/date/vendor, auto-suggest which transaction to match. Unmatched receipts sit in an inbox until linked.

**Why:** The current flow requires navigating to a specific transaction to attach a receipt. Auto-matching enables the "snap now, link later" mobile workflow — the most natural way to capture receipts in real life. Closest to Expensify UX.

**Effort:** L (human: ~2 weeks) / with CC: M (~45 min)

**Depends on:** Receipts feature + OCR pipeline + gallery page (Phase 2).

**Context:** Explicitly rejected as Approach C in the office-hours design doc (2026-03-21). The nullable `transaction_guid` and PATCH link endpoint lay the groundwork. Requires: fuzzy date/amount matching algorithm, vendor name normalization, confidence scoring, and UI for reviewing/confirming matches. Risk of false matches — needs a confirmation step, not auto-link.

---

## P2 - Monte Carlo FIRE Projections

**What:** Replace the single-line FIRE projection with a Monte Carlo simulation that samples from historical market return distributions. Show confidence bands (e.g., 10th/25th/50th/75th/90th percentile outcomes) instead of a single deterministic line.

**Why:** The current FIRE projection uses a single expected return rate (default 7%), which gives a false sense of precision. Real markets are volatile — a Monte Carlo approach using historical annual return distributions would show the range of possible outcomes: "you have a 75% chance of reaching FI by 2038, but a 25% chance it takes until 2042."

**Effort:** M (human: ~1 week) / with CC: M (~30 min)

**Depends on:** FIRE calculator data-driven upgrade (shipped). Needs a historical return dataset (e.g., S&P 500 annual returns 1928-present) either embedded or fetched.

**Context:** Deferred from QA review 2026-03-22. The single-year TWR (20.92%) was being used as the default expected return, which was wildly optimistic. Fixed to default to 7%. Monte Carlo would make the projection genuinely useful for planning by showing probability distributions instead of point estimates. Consider: Shiller CAPE data, sequence-of-returns risk modeling, and configurable asset allocation (stocks/bonds mix affects return distribution).

---

## P4 - Receipt AI Re-Extraction Batch Job

**What:** A "Re-extract all" button in AI settings that enqueues BullMQ jobs to re-run extraction on all existing receipts that used regex, using the newly configured AI provider.

**Why:** When a user configures AI for the first time, their existing receipts have `extraction_method: "regex"`. Re-extraction with AI would improve match quality for the backlog without requiring re-upload.

**Effort:** S (human: ~2 days) / with CC: S (~10 min)

**Depends on:** Receipt auto-matching feature with AI provider configuration.

**Context:** Deferred from eng review 2026-03-22. Users get AI extraction on new uploads immediately. The batch re-extraction is a nice-to-have that adds batch job management complexity. Users can also manually trigger re-extraction per receipt.
