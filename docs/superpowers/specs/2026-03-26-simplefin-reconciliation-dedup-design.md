# SimpleFin Import: Manual Transaction Reconciliation & Transfer Dedup

**Date:** 2026-03-26
**Status:** Design approved
**Priority:** P2
**Effort:** M (~45 min with CC)

## Overview

Two related features for the SimpleFin import pipeline:

1. **Manual transaction reconciliation** — When a SimpleFin transaction matches an existing manually-entered transaction in the same account, link them instead of creating a duplicate.
2. **Transfer dedup** — When a transfer appears in two SimpleFin-mapped accounts (e.g., checking → savings), create one transaction instead of two.

Both use a **match-first pipeline**: the sync engine checks for matches before creating new transactions. No buffering, no post-processing, no temporary duplicates.

## Match-First Pipeline

The sync engine's per-transaction loop gains a match step before transaction creation:

```
For each SimpleFin transaction:
  1. Skip if simplefin_transaction_id already exists (existing dedup — unchanged)
  2. Manual reconciliation match: search mapped GnuCash account for unreconciled
     transactions with exact amount and post_date within ±3 days, no existing
     simplefin_transaction_id
  3. Transfer dedup match: search other SimpleFin-mapped accounts for a recently
     imported transaction with opposite amount within ±3 days
  4. If match found → link metadata, skip creation
  5. If no match → create transaction (current behavior)
```

Match priority: manual reconciliation (step 2) is checked first, then transfer dedup (step 3). If both match, manual reconciliation wins (stronger signal — user explicitly entered it).

## Manual Reconciliation Matching

### Query Logic

For each incoming SimpleFin transaction, query the mapped GnuCash account for candidates:

- Same account (the GnuCash account mapped to this SimpleFin feed)
- Exact amount match (`value_num/value_denom` equals SimpleFin amount)
- Post date within ±3 days of SimpleFin posted date
- No existing `simplefin_transaction_id` in `gnucash_web_transaction_meta` (not already linked to a SimpleFin import)
- Not soft-deleted (`deleted_at IS NULL`)

### On Match

- If the transaction already has a `gnucash_web_transaction_meta` row (source='manual'), update it: set `simplefin_transaction_id`, `matched_at` timestamp, `match_type='manual_reconciliation'`, `match_confidence` ('high' for ±1 day, 'medium' for ±3 days)
- If no meta row exists, create one with source='manual', reviewed=true (user entered it), plus the SimpleFin linkage fields

### Confidence Tiers

- **High confidence**: Exact amount + date within ±1 day → auto-match
- **Medium confidence**: Exact amount + date within ±3 days → auto-match

Both tiers auto-match. The confidence is recorded for visibility, not gating.

### Tie-Breaking

If multiple candidates match:
1. Pick the one closest in date
2. If tied, pick the one whose `description` shares the longest common prefix with the SimpleFin transaction description (case-insensitive, after trimming)
3. If still tied, pick the oldest (first-entered)

## Transfer Dedup

### Detection Criteria

For each incoming SimpleFin transaction, after manual reconciliation check fails, search for a matching transaction imported from a *different* SimpleFin-mapped account in the same connection:

- Opposite amount (incoming is +$500, existing is -$500, or vice versa)
- Post date within ±3 days
- Existing transaction's source is 'simplefin' in `gnucash_web_transaction_meta`
- Existing transaction has a split in a different SimpleFin-mapped account

Only applies between two SimpleFin-mapped accounts. If the destination account doesn't have a SimpleFin feed, there's no second import to dedup.

### On Match (First-In Wins)

The existing transaction already has two splits (bank account + guessed destination). The guessed destination split is **replaced** with a split pointing to the second SimpleFin-mapped account, turning a single-sided import into a proper transfer.

- Update the destination split's `account_guid` to the second account
- Store the second `simplefin_transaction_id` in `simplefin_transaction_id_2`
- Set `match_type='transfer_dedup'` on the metadata
- Update confidence to 'high' (both bank feeds confirmed)

**Happy path:** If the first import's category guesser already pointed the destination split to the correct second account, just link metadata without modifying splits.

### Tie-Breaking

Same as manual reconciliation: closest date, then oldest transaction.

## Schema Changes

New columns on `gnucash_web_transaction_meta`:

| Column | Type | Description |
|--------|------|-------------|
| `match_type` | `VARCHAR(30)` | NULL, `'manual_reconciliation'`, `'transfer_dedup'` |
| `match_confidence` | `VARCHAR(10)` | NULL, `'high'`, `'medium'` |
| `matched_at` | `TIMESTAMP` | When the match occurred |
| `simplefin_transaction_id_2` | `VARCHAR(255)` | Second feed's transaction ID (transfer dedup) |

Plus index on `simplefin_transaction_id_2` for transfer dedup lookups.

No new tables needed.

## UI Indicators

### Manual Reconciliation Match

- Remove the "Imported" badge (user entered it manually)
- Add a "Bank-verified" indicator (checkmark or similar) showing SimpleFin confirmed this transaction
- Keep `reviewed=true` (user entered it, no review needed)

### Transfer Dedup Match

- Show as a normal transfer transaction (two accounts visible in splits)
- "Imported" badge remains (SimpleFin created it)
- Tooltip or detail view shows "Verified by both bank feeds"

### Sync Results Summary

Add `transactionsMatched` to sync response, broken down by type:

```typescript
{
  transactionsImported: number,
  transactionsSkipped: number,
  transactionsMatched: {
    manualReconciliation: number,
    transferDedup: number
  }
}
```

Displayed in sync results UI: "3 matched to existing, 2 transfers deduplicated"

## Testing Strategy

### Unit Tests (`src/lib/services/__tests__/`)

**Manual reconciliation:**
- Exact amount + same day (high confidence match)
- Exact amount + 3 days offset (medium confidence match)
- Exact amount + 4 days offset (no match)
- Different amount (no match)
- Multiple candidates (tie-breaking by date proximity, then description similarity, then oldest)

**Transfer dedup:**
- Matching opposite amounts across two mapped accounts
- Same-amount non-transfer (destination not SimpleFin-mapped → no match)
- Split replacement when guessed destination differs from actual second account
- Happy path: guessed destination already correct, just link metadata

**Edge cases:**
- Transaction matches both manual and transfer criteria (manual wins)
- Pending SimpleFin transactions
- Split transactions
- Metadata correctly populated for each match type
- Sync summary counts are accurate
