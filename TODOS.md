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
