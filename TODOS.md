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
