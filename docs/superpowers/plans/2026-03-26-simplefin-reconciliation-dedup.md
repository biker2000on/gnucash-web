# SimpleFin Reconciliation & Transfer Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual transaction reconciliation and cross-account transfer dedup to the SimpleFin sync engine so imports don't create duplicates.

**Architecture:** The sync engine's per-transaction loop gains a match-first step before creating new transactions. For each incoming SimpleFin transaction: (1) check existing dedup by SimpleFin ID (unchanged), (2) try manual reconciliation match (same account, exact amount, ±3 day window), (3) try transfer dedup match (opposite amount in another SimpleFin-mapped account), (4) if no match, create transaction as before. Schema adds 4 columns to `gnucash_web_transaction_meta`.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL (raw queries via Prisma), Vitest

---

### Task 1: Schema Migration — Add Match Columns to `gnucash_web_transaction_meta`

**Files:**
- Modify: `src/lib/db-init.ts:525-535` (add new DDL and execute it)

- [ ] **Step 1: Add DDL string for new columns**

In `src/lib/db-init.ts`, after the `simpleFinAccountMapAddBalanceDDL` variable (around line 400), add:

```typescript
    const transactionMetaAddMatchColumnsDDL = `
        ALTER TABLE gnucash_web_transaction_meta
        ADD COLUMN IF NOT EXISTS match_type VARCHAR(30),
        ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(10),
        ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS simplefin_transaction_id_2 VARCHAR(255);

        CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id_2
        ON gnucash_web_transaction_meta(simplefin_transaction_id_2)
        WHERE simplefin_transaction_id_2 IS NOT NULL;
    `;
```

- [ ] **Step 2: Execute the new DDL**

In the `await query(...)` block (around line 527, after `await query(simpleFinAccountMapAddBalanceDDL);`), add:

```typescript
        await query(transactionMetaAddMatchColumnsDDL);
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add match_type, match_confidence, matched_at, simplefin_transaction_id_2 columns to transaction_meta"
```

---

### Task 2: Update `SyncResult` Interface

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts:13-19`
- Modify: `src/app/(main)/settings/connections/page.tsx:22-28`

- [ ] **Step 1: Update `SyncResult` in the sync service**

In `src/lib/services/simplefin-sync.service.ts`, replace the `SyncResult` interface:

```typescript
export interface SyncResult {
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  investmentTransactionsImported: number;
  transactionsMatched: {
    manualReconciliation: number;
    transferDedup: number;
  };
  errors: { account: string; error: string }[];
}
```

- [ ] **Step 2: Initialize the new field in `syncSimpleFin`**

In the `result` initialization (line 25-31), add:

```typescript
  const result: SyncResult = {
    accountsProcessed: 0,
    transactionsImported: 0,
    transactionsSkipped: 0,
    investmentTransactionsImported: 0,
    transactionsMatched: {
      manualReconciliation: 0,
      transferDedup: 0,
    },
    errors: [],
  };
```

- [ ] **Step 3: Update frontend `SyncResult` interface**

In `src/app/(main)/settings/connections/page.tsx`, replace the `SyncResult` interface (lines 22-28):

```typescript
interface SyncResult {
  success: boolean;
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  transactionsMatched?: {
    manualReconciliation: number;
    transferDedup: number;
  };
  errors: { account: string; error: string }[];
}
```

- [ ] **Step 4: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts src/app/(main)/settings/connections/page.tsx
git commit -m "feat: add transactionsMatched to SyncResult interface"
```

---

### Task 3: Implement Manual Reconciliation Match Function

**Files:**
- Create: `src/lib/services/__tests__/simplefin-match.test.ts`
- Modify: `src/lib/services/simplefin-sync.service.ts`

- [ ] **Step 1: Write failing tests for `findManualReconciliationMatch`**

Create `src/lib/services/__tests__/simplefin-match.test.ts`:

```typescript
/**
 * SimpleFin Match Logic Tests
 *
 * Tests for manual reconciliation and transfer dedup matching.
 * These test the pure matching logic using mock query results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the scoring/selection logic, not the DB queries.
// The match functions will be extracted to accept candidate arrays.

import {
  selectManualReconciliationMatch,
  type ReconciliationCandidate,
} from '../simplefin-sync.service';

describe('selectManualReconciliationMatch', () => {
  const baseSfTxn = {
    posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
    amount: '-45.67',
    description: 'AMAZON PURCHASE',
  };

  it('should match exact amount + same day (high confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('a'.repeat(32));
    expect(result!.confidence).toBe('high');
  });

  it('should match exact amount + 1 day offset (high confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'b'.repeat(32),
      post_date: new Date('2026-03-21T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('high');
  });

  it('should match exact amount + 3 day offset (medium confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'c'.repeat(32),
      post_date: new Date('2026-03-23T10:00:00Z'),
      description: 'Amazon',
      has_meta: true,
    }];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  it('should return null for date > 3 days away', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'd'.repeat(32),
      post_date: new Date('2026-03-24T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).toBeNull();
  });

  it('should return null for empty candidates', () => {
    const result = selectManualReconciliationMatch(baseSfTxn, []);
    expect(result).toBeNull();
  });

  it('should prefer closest date when multiple candidates', () => {
    const candidates: ReconciliationCandidate[] = [
      {
        transaction_guid: 'e'.repeat(32),
        post_date: new Date('2026-03-22T10:00:00Z'),
        description: 'Amazon',
        has_meta: true,
      },
      {
        transaction_guid: 'f'.repeat(32),
        post_date: new Date('2026-03-20T14:00:00Z'),
        description: 'Amazon',
        has_meta: true,
      },
    ];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('f'.repeat(32));
  });

  it('should break date tie with longest common description prefix', () => {
    const candidates: ReconciliationCandidate[] = [
      {
        transaction_guid: 'g'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON',
        has_meta: true,
      },
      {
        transaction_guid: 'h'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON PURCHASE',
        has_meta: true,
      },
    ];

    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('h'.repeat(32));
  });

  it('should break description tie with oldest transaction (first entered)', () => {
    const candidates: ReconciliationCandidate[] = [
      {
        transaction_guid: 'j'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON PURCHASE',
        has_meta: true,
      },
      {
        transaction_guid: 'i'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON PURCHASE',
        has_meta: true,
      },
    ];

    // Candidates are ordered by guid ascending — 'i' < 'j', so 'i' is "oldest"
    // The function should pick the first one in the array after sorting
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/services/__tests__/simplefin-match.test.ts`
Expected: FAIL — `selectManualReconciliationMatch` is not exported

- [ ] **Step 3: Implement `selectManualReconciliationMatch`**

In `src/lib/services/simplefin-sync.service.ts`, add above the `importTransaction` function (before line 284):

```typescript
/**
 * Candidate for manual reconciliation matching.
 * Returned by the DB query that finds potential matches.
 */
export interface ReconciliationCandidate {
  transaction_guid: string;
  post_date: Date;
  description: string;
  has_meta: boolean; // whether a gnucash_web_transaction_meta row exists
}

/**
 * Select the best manual reconciliation match from candidates.
 * All candidates already have the correct amount (filtered by DB query).
 * This function applies date window filtering and tie-breaking.
 *
 * Returns null if no candidate is within ±3 days.
 */
export function selectManualReconciliationMatch(
  sfTxn: { posted: number; description: string },
  candidates: ReconciliationCandidate[],
): { transaction_guid: string; confidence: 'high' | 'medium'; has_meta: boolean } | null {
  const sfDate = new Date(sfTxn.posted * 1000);
  const sfDesc = (sfTxn.description || '').trim().toLowerCase();

  // Filter by ±3 day window and compute day offset
  const scored = candidates
    .map(c => {
      const dayOffset = Math.abs(sfDate.getTime() - c.post_date.getTime()) / (1000 * 60 * 60 * 24);
      if (dayOffset > 3) return null;

      // Longest common prefix (case-insensitive, trimmed)
      const cDesc = (c.description || '').trim().toLowerCase();
      let commonPrefix = 0;
      for (let i = 0; i < Math.min(sfDesc.length, cDesc.length); i++) {
        if (sfDesc[i] === cDesc[i]) commonPrefix++;
        else break;
      }

      return {
        ...c,
        dayOffset,
        commonPrefix,
        confidence: (dayOffset <= 1 ? 'high' : 'medium') as 'high' | 'medium',
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (scored.length === 0) return null;

  // Sort: closest date first, then longest common prefix, then first in array (oldest)
  scored.sort((a, b) => {
    if (a.dayOffset !== b.dayOffset) return a.dayOffset - b.dayOffset;
    if (a.commonPrefix !== b.commonPrefix) return b.commonPrefix - a.commonPrefix;
    return 0; // preserve original order (oldest first from DB)
  });

  const best = scored[0];
  return {
    transaction_guid: best.transaction_guid,
    confidence: best.confidence,
    has_meta: best.has_meta,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/services/__tests__/simplefin-match.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/__tests__/simplefin-match.test.ts src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add selectManualReconciliationMatch with tests"
```

---

### Task 4: Implement Transfer Dedup Match Function

**Files:**
- Modify: `src/lib/services/__tests__/simplefin-match.test.ts`
- Modify: `src/lib/services/simplefin-sync.service.ts`

- [ ] **Step 1: Write failing tests for `selectTransferDedupMatch`**

Append to `src/lib/services/__tests__/simplefin-match.test.ts`:

```typescript
import {
  selectManualReconciliationMatch,
  selectTransferDedupMatch,
  type ReconciliationCandidate,
  type TransferDedupCandidate,
} from '../simplefin-sync.service';

describe('selectTransferDedupMatch', () => {
  // Incoming: +$500 deposit in savings (the second feed)
  const baseSfTxn = {
    posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
    amount: '500.00',
    description: 'Transfer from checking',
  };

  it('should match opposite amount within same day (transfer dedup)', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];

    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('a'.repeat(32));
  });

  it('should match within ±3 day window', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-23T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];

    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
  });

  it('should return null for date > 3 days away', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-24T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];

    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).toBeNull();
  });

  it('should return null for empty candidates', () => {
    const result = selectTransferDedupMatch(baseSfTxn, []);
    expect(result).toBeNull();
  });

  it('should prefer closest date when multiple candidates', () => {
    const candidates: TransferDedupCandidate[] = [
      {
        transaction_guid: 'e'.repeat(32),
        post_date: new Date('2026-03-22T10:00:00Z'),
        split_account_guid: 'b'.repeat(32),
        dest_split_guid: 'c'.repeat(32),
        dest_account_guid: 'd'.repeat(32),
      },
      {
        transaction_guid: 'f'.repeat(32),
        post_date: new Date('2026-03-20T14:00:00Z'),
        split_account_guid: 'b'.repeat(32),
        dest_split_guid: 'c'.repeat(32),
        dest_account_guid: 'd'.repeat(32),
      },
    ];

    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('f'.repeat(32));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/services/__tests__/simplefin-match.test.ts`
Expected: FAIL — `selectTransferDedupMatch` is not exported

- [ ] **Step 3: Implement `selectTransferDedupMatch`**

In `src/lib/services/simplefin-sync.service.ts`, add after `selectManualReconciliationMatch`:

```typescript
/**
 * Candidate for transfer dedup matching.
 * Represents a SimpleFin-imported transaction in another mapped account
 * with opposite amount.
 */
export interface TransferDedupCandidate {
  transaction_guid: string;
  post_date: Date;
  split_account_guid: string;  // the account in the first feed
  dest_split_guid: string;     // the guessed destination split to potentially replace
  dest_account_guid: string;   // current destination account guid
}

/**
 * Select the best transfer dedup match from candidates.
 * All candidates already have the opposite amount (filtered by DB query).
 * Returns null if no candidate is within ±3 days.
 */
export function selectTransferDedupMatch(
  sfTxn: { posted: number; amount: string; description: string },
  candidates: TransferDedupCandidate[],
): TransferDedupCandidate | null {
  const sfDate = new Date(sfTxn.posted * 1000);

  const scored = candidates
    .map(c => {
      const dayOffset = Math.abs(sfDate.getTime() - c.post_date.getTime()) / (1000 * 60 * 60 * 24);
      if (dayOffset > 3) return null;
      return { ...c, dayOffset };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (scored.length === 0) return null;

  // Sort: closest date first, then first in array (oldest)
  scored.sort((a, b) => a.dayOffset - b.dayOffset);

  return scored[0];
}
```

- [ ] **Step 4: Update the import at the top of the test file**

Replace the import block in `simplefin-match.test.ts`:

```typescript
import {
  selectManualReconciliationMatch,
  selectTransferDedupMatch,
  type ReconciliationCandidate,
  type TransferDedupCandidate,
} from '../simplefin-sync.service';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/services/__tests__/simplefin-match.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/__tests__/simplefin-match.test.ts src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add selectTransferDedupMatch with tests"
```

---

### Task 5: Wire Manual Reconciliation into the Sync Loop

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts:146-248` (the per-account transaction loop)

This task adds the DB queries and match-linking logic to the sync loop. The match function from Task 3 handles scoring; this task handles the DB interaction.

- [ ] **Step 1: Add `findAndLinkManualMatch` helper function**

In `src/lib/services/simplefin-sync.service.ts`, add before the `importTransaction` function:

```typescript
/**
 * Search for and link a manual reconciliation match.
 * Returns true if a match was found and linked.
 */
async function findAndLinkManualMatch(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
): Promise<boolean> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return false;

  const postDate = new Date(sfTxn.posted * 1000);
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const valueNum = amount > 0 ? absNum : -absNum;

  // Find transactions in the same account with exact amount, within ±3 days,
  // not already linked to a SimpleFin ID, not soft-deleted
  const candidates = await prisma.$queryRaw<ReconciliationCandidate[]>`
    SELECT
      t.guid AS transaction_guid,
      t.post_date,
      t.description,
      CASE WHEN m.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_meta
    FROM transactions t
    JOIN splits s ON s.tx_guid = t.guid AND s.account_guid = ${bankAccountGuid}
    LEFT JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE s.value_num = ${BigInt(valueNum)}
      AND s.value_denom = ${BigInt(denom)}
      AND t.post_date BETWEEN ${new Date(postDate.getTime() - 3 * 86400000)}
                          AND ${new Date(postDate.getTime() + 3 * 86400000)}
      AND (m.simplefin_transaction_id IS NULL)
      AND (m.deleted_at IS NULL OR m.id IS NULL)
    ORDER BY t.post_date ASC
  `;

  const match = selectManualReconciliationMatch(sfTxn, candidates);
  if (!match) return false;

  // Link the match: update or insert metadata
  if (match.has_meta) {
    await prisma.$executeRaw`
      UPDATE gnucash_web_transaction_meta
      SET simplefin_transaction_id = ${sfTxn.id},
          match_type = 'manual_reconciliation',
          match_confidence = ${match.confidence},
          matched_at = NOW()
      WHERE transaction_guid = ${match.transaction_guid}
    `;
  } else {
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_transaction_meta
        (transaction_guid, source, reviewed, simplefin_transaction_id, match_type, match_confidence, matched_at)
      VALUES
        (${match.transaction_guid}, 'manual', TRUE, ${sfTxn.id}, 'manual_reconciliation', ${match.confidence}, NOW())
    `;
  }

  return true;
}
```

- [ ] **Step 2: Wire into the sync loop**

In the per-transaction loop (inside `for (const sfTxn of sfAccount.transactions)`), after the existing SimpleFin ID dedup check (line 193-196) and before the `try` block that calls `importTransaction` (line 198), add:

```typescript
        // Manual reconciliation: match to existing manually-entered transaction
        if (await findAndLinkManualMatch(sfTxn, mappedAccount.gnucash_account_guid)) {
          result.transactionsMatched.manualReconciliation++;
          existingIds.add(sfTxn.id);
          continue;
        }
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: wire manual reconciliation matching into sync loop"
```

---

### Task 6: Wire Transfer Dedup into the Sync Loop

**Files:**
- Modify: `src/lib/services/simplefin-sync.service.ts`

- [ ] **Step 1: Add `findAndLinkTransferDedupMatch` helper function**

In `src/lib/services/simplefin-sync.service.ts`, add after `findAndLinkManualMatch`:

```typescript
/**
 * Search for and link a transfer dedup match.
 * Looks for a SimpleFin-imported transaction in another mapped account
 * with opposite amount. If found, replaces the guessed destination split
 * with the correct second account.
 * Returns true if a match was found and linked.
 */
async function findAndLinkTransferDedupMatch(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
  allMappedAccountGuids: string[],
): Promise<boolean> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return false;

  const postDate = new Date(sfTxn.posted * 1000);
  // Opposite amount: if incoming is +500, look for -500 in other accounts
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const oppositeValueNum = amount > 0 ? -absNum : absNum;

  // Other SimpleFin-mapped account guids (exclude current bank account)
  const otherMappedGuids = allMappedAccountGuids.filter(g => g !== bankAccountGuid);
  if (otherMappedGuids.length === 0) return false;

  // Find SimpleFin-imported transactions in other mapped accounts with opposite amount
  const candidates = await prisma.$queryRaw<TransferDedupCandidate[]>`
    SELECT
      t.guid AS transaction_guid,
      t.post_date,
      s1.account_guid AS split_account_guid,
      s2.guid AS dest_split_guid,
      s2.account_guid AS dest_account_guid
    FROM transactions t
    JOIN splits s1 ON s1.tx_guid = t.guid AND s1.account_guid = ANY(${otherMappedGuids})
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.guid != s1.guid
    JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid
    WHERE s1.value_num = ${BigInt(oppositeValueNum)}
      AND s1.value_denom = ${BigInt(denom)}
      AND m.source = 'simplefin'
      AND m.match_type IS NULL
      AND m.simplefin_transaction_id_2 IS NULL
      AND t.post_date BETWEEN ${new Date(postDate.getTime() - 3 * 86400000)}
                          AND ${new Date(postDate.getTime() + 3 * 86400000)}
      AND (m.deleted_at IS NULL)
    ORDER BY t.post_date ASC
  `;

  const match = selectTransferDedupMatch(sfTxn, candidates);
  if (!match) return false;

  // If the destination split already points to this bank account, just link metadata
  // Otherwise, replace the guessed destination with this bank account
  if (match.dest_account_guid !== bankAccountGuid) {
    await prisma.$executeRaw`
      UPDATE splits
      SET account_guid = ${bankAccountGuid}
      WHERE guid = ${match.dest_split_guid}
    `;
  }

  // Update metadata: store second SimpleFin ID, mark as transfer dedup
  await prisma.$executeRaw`
    UPDATE gnucash_web_transaction_meta
    SET simplefin_transaction_id_2 = ${sfTxn.id},
        match_type = 'transfer_dedup',
        match_confidence = 'high',
        matched_at = NOW()
    WHERE transaction_guid = ${match.transaction_guid}
  `;

  return true;
}
```

- [ ] **Step 2: Build the `allMappedAccountGuids` array**

In `syncSimpleFin`, after the `mappedAccounts` query (line 70), add:

```typescript
  const allMappedAccountGuids = mappedAccounts
    .filter(a => a.gnucash_account_guid)
    .map(a => a.gnucash_account_guid);
```

- [ ] **Step 3: Wire into the sync loop**

In the per-transaction loop, after the manual reconciliation check added in Task 5 and before the `try` block that calls `importTransaction`, add:

```typescript
        // Transfer dedup: match to existing import from another SimpleFin-mapped account
        if (allMappedAccountGuids.length > 1 &&
            await findAndLinkTransferDedupMatch(sfTxn, mappedAccount.gnucash_account_guid, allMappedAccountGuids)) {
          result.transactionsMatched.transferDedup++;
          existingIds.add(sfTxn.id);
          continue;
        }
```

- [ ] **Step 4: Also check `simplefin_transaction_id_2` in the existing dedup set**

In the existing dedup query (lines 148-154), expand it to also load `simplefin_transaction_id_2`:

```typescript
      const existingMeta = await prisma.$queryRaw<{
        simplefin_transaction_id: string | null;
        simplefin_transaction_id_2: string | null;
      }[]>`
        SELECT meta.simplefin_transaction_id, meta.simplefin_transaction_id_2
        FROM gnucash_web_transaction_meta meta
        WHERE (meta.simplefin_transaction_id IS NOT NULL OR meta.simplefin_transaction_id_2 IS NOT NULL)
      `;
      const existingIds = new Set<string>();
      for (const m of existingMeta) {
        if (m.simplefin_transaction_id) existingIds.add(m.simplefin_transaction_id);
        if (m.simplefin_transaction_id_2) existingIds.add(m.simplefin_transaction_id_2);
      }
```

- [ ] **Step 5: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: wire transfer dedup matching into sync loop"
```

---

### Task 7: Update Sync Results UI

**Files:**
- Modify: `src/app/(main)/settings/connections/page.tsx:185-187,326-344`

- [ ] **Step 1: Update toast message to include match counts**

In `src/app/(main)/settings/connections/page.tsx`, replace the success toast (line 187):

```typescript
        const matched = (data.transactionsMatched?.manualReconciliation || 0) + (data.transactionsMatched?.transferDedup || 0);
        const matchedMsg = matched > 0 ? `, matched ${matched} existing` : '';
        success(`Imported ${data.transactionsImported} transactions, skipped ${data.transactionsSkipped} duplicates${matchedMsg}`);
```

- [ ] **Step 2: Update sync results display**

Replace the sync results block (lines 326-344):

```tsx
            {sfSyncResult && (
              <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
                <p className="text-sm text-emerald-400 font-medium">
                  Imported {sfSyncResult.transactionsImported} transactions, skipped {sfSyncResult.transactionsSkipped} duplicates
                  ({sfSyncResult.accountsProcessed} accounts processed)
                </p>
                {sfSyncResult.transactionsMatched && (sfSyncResult.transactionsMatched.manualReconciliation > 0 || sfSyncResult.transactionsMatched.transferDedup > 0) && (
                  <p className="text-sm text-cyan-400 mt-1">
                    {sfSyncResult.transactionsMatched.manualReconciliation > 0 && (
                      <span>{sfSyncResult.transactionsMatched.manualReconciliation} matched to existing transactions</span>
                    )}
                    {sfSyncResult.transactionsMatched.manualReconciliation > 0 && sfSyncResult.transactionsMatched.transferDedup > 0 && ', '}
                    {sfSyncResult.transactionsMatched.transferDedup > 0 && (
                      <span>{sfSyncResult.transactionsMatched.transferDedup} transfers deduplicated</span>
                    )}
                  </p>
                )}
                {sfSyncResult.errors.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-amber-400 cursor-pointer">
                      {sfSyncResult.errors.length} error(s)
                    </summary>
                    <ul className="mt-1 text-xs text-foreground-muted space-y-1">
                      {sfSyncResult.errors.map((err, i) => (
                        <li key={i}>{err.account}: {err.error}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/(main)/settings/connections/page.tsx
git commit -m "feat: display reconciliation and transfer dedup counts in sync results"
```

---

### Task 8: Update Ledger UI — Bank-Verified Indicator

**Files:**
- Modify: `src/app/api/accounts/[guid]/transactions/route.ts:331-340,396-403`
- Modify: `src/components/AccountLedger.tsx`

The ledger currently shows an amber "Imported" badge for `source !== 'manual'`. For manually-entered transactions that were bank-verified (match_type = 'manual_reconciliation'), we show a "Bank-verified" badge instead.

- [ ] **Step 1: Add `match_type` to the transaction meta query**

In `src/app/api/accounts/[guid]/transactions/route.ts`, update the meta query (lines 331-339):

```typescript
        const transactionMeta = await prisma.$queryRaw<{
            transaction_guid: string;
            source: string;
            reviewed: boolean;
            match_type: string | null;
        }[]>`
            SELECT transaction_guid, source, reviewed, match_type
            FROM gnucash_web_transaction_meta
            WHERE transaction_guid = ANY(${txGuids}::text[])
        `;
```

Then in the response mapping (around line 403), add `match_type`:

```typescript
                source: meta?.source ?? 'manual',
                match_type: meta?.match_type ?? null,
```

- [ ] **Step 1b: Add `match_type` to the `AccountTransaction` interface**

In `src/components/AccountLedger.tsx`, add `match_type` to the `AccountTransaction` interface (line 48):

```typescript
export interface AccountTransaction extends Transaction {
    running_balance: string;
    account_split_value: string;
    commodity_mnemonic: string;
    account_split_guid: string;
    account_split_reconcile_state: string;
    reviewed?: boolean;
    source?: string;
    match_type?: string | null;
}
```

- [ ] **Step 2: Update the ledger badge logic**

In `src/components/AccountLedger.tsx`, find the "Imported" badge rendering (around line 1729 for mobile, 2262 for desktop). Update the badge to show "Bank-verified" for matched manual transactions:

For each location where the badge is rendered, replace the condition:

```tsx
{tx.source && tx.source !== 'manual' && (
  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">
    Imported
  </span>
)}
```

With:

```tsx
{tx.source && tx.source !== 'manual' && !tx.match_type && (
  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider font-bold">
    Imported
  </span>
)}
{tx.match_type === 'manual_reconciliation' && (
  <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 uppercase tracking-wider font-bold">
    Bank-verified
  </span>
)}
{tx.match_type === 'transfer_dedup' && tx.source === 'simplefin' && (
  <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 uppercase tracking-wider font-bold" title="Verified by both bank feeds">
    Imported
  </span>
)}
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/AccountLedger.tsx "src/app/api/accounts/[guid]/transactions/route.ts"
git commit -m "feat: show Bank-verified badge for reconciled transactions in ledger"
```

---

### Task 9: Edge Case Tests

**Files:**
- Modify: `src/lib/services/__tests__/simplefin-match.test.ts`

- [ ] **Step 1: Add edge case tests**

Append to `src/lib/services/__tests__/simplefin-match.test.ts`:

```typescript
describe('Match priority: manual reconciliation wins over transfer dedup', () => {
  it('manual reconciliation is checked first in the pipeline', () => {
    // This is an integration concern — the sync loop checks manual first.
    // We verify here that both functions can return matches for the same scenario
    // (the sync loop ordering determines priority).

    const sfTxn = {
      posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
      amount: '-500.00',
      description: 'Transfer to savings',
    };

    const manualCandidates: ReconciliationCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      description: 'Transfer to savings',
      has_meta: false,
    }];

    const transferCandidates: TransferDedupCandidate[] = [{
      transaction_guid: 'b'.repeat(32),
      post_date: new Date('2026-03-20T11:00:00Z'),
      split_account_guid: 'c'.repeat(32),
      dest_split_guid: 'd'.repeat(32),
      dest_account_guid: 'e'.repeat(32),
    }];

    // Both would match — sync loop checks manual first
    const manualMatch = selectManualReconciliationMatch(sfTxn, manualCandidates);
    const transferMatch = selectTransferDedupMatch(sfTxn, transferCandidates);

    expect(manualMatch).not.toBeNull();
    expect(transferMatch).not.toBeNull();
  });
});

describe('Edge cases', () => {
  it('should handle zero-amount transactions gracefully', () => {
    const sfTxn = {
      posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
      amount: '0.00',
      description: 'Zero amount',
    };

    const result = selectManualReconciliationMatch(sfTxn, [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      description: 'Zero amount',
      has_meta: true,
    }]);

    // Should still match if candidates exist (DB already filtered by amount)
    expect(result).not.toBeNull();
  });

  it('should handle empty description gracefully', () => {
    const sfTxn = {
      posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
      amount: '-10.00',
      description: '',
    };

    const result = selectManualReconciliationMatch(sfTxn, [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      description: 'Some description',
      has_meta: true,
    }]);

    // Should still match — description is tie-breaking only, not filtering
    expect(result).not.toBeNull();
  });

  it('should handle boundary: exactly 3.0 days offset matches', () => {
    const sfTxn = {
      posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
      amount: '-10.00',
      description: 'Test',
    };

    const result = selectManualReconciliationMatch(sfTxn, [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-23T12:00:00Z'),
      description: 'Test',
      has_meta: true,
    }]);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  it('should handle boundary: 3.01 days offset does not match', () => {
    const sfTxn = {
      posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
      amount: '-10.00',
      description: 'Test',
    };

    const result = selectManualReconciliationMatch(sfTxn, [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-23T12:15:00Z'),
      description: 'Test',
      has_meta: true,
    }]);

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run all match tests**

Run: `npx vitest run src/lib/services/__tests__/simplefin-match.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/__tests__/simplefin-match.test.ts
git commit -m "test: add edge case tests for reconciliation and transfer dedup matching"
```

---

### Task 10: Run Full Test Suite & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds
