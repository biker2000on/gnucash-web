# Lot Scrub Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GnuCash-compatible scrub engine that splits sells across lots, links transfers to lots with acquisition dates, and auto-generates capital gains transactions.

**Architecture:** New `lot-scrub.ts` module contains the three core algorithms (sell splitting, transfer linking, gains generation). It's called by the existing `lot-assignment.ts` during auto-assign. A new scrub-all endpoint processes accounts in topological order (source accounts first). Each scrub run is tagged with a `run_id` for revertability.

**Tech Stack:** TypeScript, Prisma ORM, Next.js API routes, Vitest for testing, React for UI components.

**Design doc:** `~/.gstack/projects/biker2000on-gnucash-web/justin-feat-investment-lots-design-20260322-120410.md`

**Working directory:** `/home/justin/projects/gnucash-web/.worktrees/feat-investment-lots`

---

## File Structure

```
src/lib/
├── gnucash.ts                    # EXTEND: add toDecimalNumber(), findOrCreateAccount()
├── lot-scrub.ts                  # NEW: core scrub engine (3 algorithms)
├── lot-assignment.ts             # EXTEND: integrate scrub engine, add scrubAll
├── lots.ts                       # EXTEND: add sourceLotGuid, acquisitionDate to LotSummary
├── cost-basis.ts                 # EXTEND: replace local toDecimal with import
├── __tests__/
│   ├── lot-scrub.test.ts         # NEW: 25+ unit tests for scrub engine
│   └── gnucash-accounts.test.ts  # NEW: tests for findOrCreateAccount
src/app/api/
├── accounts/[guid]/lots/
│   ├── auto-assign/route.ts      # EXTEND: return gains info
│   ├── clear-assign/route.ts     # EXTEND: clean up gains txs + metadata slots
│   └── revert/route.ts           # NEW: revert last scrub by run_id
├── lots/
│   └── scrub-all/route.ts        # NEW: scrub all investment accounts
src/components/
├── ledger/
│   ├── AutoAssignDialog.tsx       # EXTEND: show post-scrub summary
│   └── LotViewer.tsx              # EXTEND: show transfer source + gains txs
├── investments/
│   └── ScrubAllButton.tsx         # NEW: global scrub button with confirmation
src/app/(main)/investments/
└── page.tsx                       # EXTEND: add ScrubAllButton
```

---

### Task 1: Consolidate `toDecimalNumber()` in gnucash.ts

**Files:**
- Modify: `src/lib/gnucash.ts`
- Modify: `src/lib/lots.ts:16-19`
- Modify: `src/lib/lot-assignment.ts:11-13`
- Modify: `src/lib/cost-basis.ts:33-36`
- Test: `src/lib/__tests__/numeric.test.ts`

- [ ] **Step 1: Add `toDecimalNumber()` to gnucash.ts**

Add after the existing `toDecimal` function in `src/lib/gnucash.ts`:

```typescript
/**
 * Converts GnuCash fraction values to a number (not string).
 * Convenience wrapper for calculations that need numeric values.
 * Returns 0 for null inputs (safe for database nullable fields).
 */
export function toDecimalNumber(
  num: bigint | number | string | null,
  denom: bigint | number | string | null
): number {
  if (num === null || denom === null) return 0;
  return parseFloat(toDecimal(num, denom));
}
```

- [ ] **Step 2: Add test for `toDecimalNumber`**

Add to `src/lib/__tests__/numeric.test.ts`:

```typescript
import { toDecimal, fromDecimal, generateGuid, toDecimalNumber } from '../gnucash';

describe('toDecimalNumber', () => {
  it('should convert fractions to numbers', () => {
    expect(toDecimalNumber(150n, 100n)).toBe(1.5);
  });

  it('should return 0 for null inputs', () => {
    expect(toDecimalNumber(null, 100n)).toBe(0);
    expect(toDecimalNumber(150n, null)).toBe(0);
    expect(toDecimalNumber(null, null)).toBe(0);
  });

  it('should handle negative values', () => {
    expect(toDecimalNumber(-50n, 100n)).toBe(-0.5);
  });
});
```

- [ ] **Step 3: Run tests to verify**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run src/lib/__tests__/numeric.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Replace local `toDecimal` helpers in lots.ts, lot-assignment.ts, cost-basis.ts**

In `src/lib/lots.ts` replace lines 9-19:
```typescript
import prisma from './prisma';
import { toDecimalNumber } from './gnucash';
import { getLatestPrice } from './commodities';
```
Then find-replace all `toDecimal(` with `toDecimalNumber(` in lots.ts (remove the local function definition).

In `src/lib/lot-assignment.ts` replace lines 8-13:
```typescript
import prisma from './prisma';
import { generateGuid, toDecimalNumber } from './gnucash';
```
Then find-replace all `toDecimal(` with `toDecimalNumber(` in lot-assignment.ts (remove the local function definition).

In `src/lib/cost-basis.ts` replace lines 13-36 (the local `toDecimal` function and its imports, but NOT the `import prisma` on line 11 which must stay):
```typescript
import { toDecimalNumber } from './gnucash';

export type CostBasisMethod = 'fifo' | 'lifo' | 'average';
```
Then find-replace all the local `toDecimal(` calls with `toDecimalNumber(` in cost-basis.ts (remove the local function definition and the `toDecimal as toDecimalString` import).

- [ ] **Step 5: Run build to verify no breakage**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run && npm run build 2>&1 | tail -5`
Expected: Tests pass, build succeeds

- [ ] **Step 6: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/lib/gnucash.ts src/lib/lots.ts src/lib/lot-assignment.ts src/lib/cost-basis.ts src/lib/__tests__/numeric.test.ts
git commit -m "refactor: consolidate toDecimalNumber() in gnucash.ts, remove 3 local copies"
```

---

### Task 2: Add `findOrCreateAccount()` to gnucash.ts

**Files:**
- Modify: `src/lib/gnucash.ts`
- Create: `src/lib/__tests__/gnucash-accounts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/gnucash-accounts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing
vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import prisma from '../prisma';
import { findOrCreateAccount } from '../gnucash';

const mockFindFirst = vi.mocked(prisma.accounts.findFirst);
const mockCreate = vi.mocked(prisma.accounts.create);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findOrCreateAccount', () => {
  it('should return existing leaf account guid when full path exists', async () => {
    // Income exists, Capital Gains exists, Short Term exists
    mockFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' } as any) // Income
      .mockResolvedValueOnce({ guid: 'capgains-guid' } as any) // Capital Gains
      .mockResolvedValueOnce({ guid: 'st-guid' } as any); // Short Term

    const result = await findOrCreateAccount(
      'Income:Capital Gains:Short Term',
      'root-guid',
      'usd-guid'
    );

    expect(result).toBe('st-guid');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should create missing segments in the hierarchy', async () => {
    // Income exists, Capital Gains does NOT, Short Term does NOT
    mockFindFirst
      .mockResolvedValueOnce({ guid: 'income-guid' } as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    mockCreate.mockResolvedValue({} as any);

    const result = await findOrCreateAccount(
      'Income:Capital Gains:Short Term',
      'root-guid',
      'usd-guid'
    );

    // Should have created 2 accounts
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // First created account: "Capital Gains" (placeholder)
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Capital Gains',
        account_type: 'INCOME',
        parent_guid: 'income-guid',
        placeholder: 1,
      }),
    });

    // Second created account: "Short Term" (not placeholder)
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Short Term',
        account_type: 'INCOME',
        placeholder: 0,
      }),
    });
  });

  it('should create the entire hierarchy when nothing exists', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({} as any);

    await findOrCreateAccount('Income:Capital Gains:Long Term', 'root-guid', 'usd-guid');

    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('should use correct commodity_guid and commodity_scu', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({} as any);

    await findOrCreateAccount('Income:Gains', 'root-guid', 'my-currency');

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commodity_guid: 'my-currency',
        commodity_scu: 100,
      }),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run src/lib/__tests__/gnucash-accounts.test.ts`
Expected: FAIL — `findOrCreateAccount` is not exported from `../gnucash`

- [ ] **Step 3: Implement `findOrCreateAccount`**

Add to `src/lib/gnucash.ts` at the bottom:

```typescript
import prisma from './prisma';

/**
 * Find or create a GnuCash account by colon-delimited path.
 * Creates missing intermediate accounts as placeholders.
 *
 * @param path - Colon-delimited account path, e.g. "Income:Capital Gains:Short Term"
 * @param bookRootGuid - The root account GUID for the book
 * @param currencyGuid - The commodity GUID for currency (e.g., USD)
 * @param tx - Optional Prisma transaction client for atomicity
 * @returns The GUID of the leaf account
 */
export async function findOrCreateAccount(
  path: string,
  bookRootGuid: string,
  currencyGuid: string,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<string> {
  const db = tx || prisma;
  const segments = path.split(':');
  let parentGuid = bookRootGuid;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    const existing = await db.accounts.findFirst({
      where: { name: segment, parent_guid: parentGuid },
      select: { guid: true },
    });

    if (existing) {
      parentGuid = existing.guid;
      continue;
    }

    // Create missing account
    const newGuid = generateGuid();
    await db.accounts.create({
      data: {
        guid: newGuid,
        name: segment,
        account_type: 'INCOME',
        commodity_guid: currencyGuid,
        commodity_scu: 100,
        parent_guid: parentGuid,
        non_std_scu: 0,
        hidden: 0,
        placeholder: isLast ? 0 : 1,
        code: '',
        description: '',
      },
    });
    parentGuid = newGuid;
  }

  return parentGuid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run src/lib/__tests__/gnucash-accounts.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/lib/gnucash.ts src/lib/__tests__/gnucash-accounts.test.ts
git commit -m "feat: add findOrCreateAccount() for auto-creating GnuCash account hierarchies"
```

---

### Task 3: Create core scrub engine `lot-scrub.ts`

**Files:**
- Create: `src/lib/lot-scrub.ts`
- Create: `src/lib/__tests__/lot-scrub.test.ts`

This is the largest task. The scrub engine has three core functions plus helpers.

- [ ] **Step 1: Create `lot-scrub.ts` with types and helpers**

Create `src/lib/lot-scrub.ts`:

```typescript
/**
 * Lot Scrub Engine
 *
 * Implements GnuCash-compatible lot scrubbing:
 * 1. Split sells across multiple lots (when sell qty > single lot balance)
 * 2. Link transfer-in splits to lots with acquisition date metadata
 * 3. Auto-generate capital gains transactions when lots close
 *
 * All operations are tagged with a run_id for revertability.
 */

import prisma from './prisma';
import { generateGuid, toDecimalNumber, fromDecimal, findOrCreateAccount } from './gnucash';

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Tax classification based on account hierarchy names
export type TaxStatus = 'TAXABLE' | 'TAX_DEFERRED' | 'TAX_EXEMPT';

export interface ScrubResult {
  lotsCreated: number;
  splitsAssigned: number;
  splitsCreated: number;      // sub-splits from sell splitting
  gainsTransactions: number;  // capital gains transactions generated
  totalRealizedGain: number;
  method: string;
  runId: string;
  warnings: string[];
}

/**
 * Classify an account's tax status by walking up the account hierarchy
 * and checking parent names for IRA/401k/Roth/HSA patterns.
 */
export async function classifyAccountTax(
  accountGuid: string,
  tx: PrismaTx
): Promise<TaxStatus> {
  const TAX_EXEMPT_PATTERNS = [/roth/i, /hsa/i, /529/i];
  const TAX_DEFERRED_PATTERNS = [/ira/i, /401k/i, /403b/i, /tsp/i];

  let currentGuid: string | null = accountGuid;

  while (currentGuid) {
    const account = await tx.accounts.findUnique({
      where: { guid: currentGuid },
      select: { name: true, parent_guid: true },
    });
    if (!account) break;

    const name = account.name;
    if (TAX_EXEMPT_PATTERNS.some(p => p.test(name))) return 'TAX_EXEMPT';
    if (TAX_DEFERRED_PATTERNS.some(p => p.test(name))) return 'TAX_DEFERRED';

    currentGuid = account.parent_guid;
  }

  return 'TAXABLE';
}

/**
 * Classify holding period based on acquisition and disposition dates.
 */
export function classifyHoldingPeriod(
  openDate: Date | string,
  closeDate: Date | string
): 'Short Term' | 'Long Term' {
  const open = new Date(openDate).getTime();
  const close = new Date(closeDate).getTime();
  return (close - open) >= ONE_YEAR_MS ? 'Long Term' : 'Short Term';
}

/**
 * Tag an entity with a slot for identification/revert purposes.
 */
async function tagEntity(
  objGuid: string,
  slotName: string,
  slotValue: string,
  tx: PrismaTx
): Promise<void> {
  await tx.slots.create({
    data: {
      obj_guid: objGuid,
      name: slotName,
      slot_type: 4,
      string_val: slotValue,
    },
  });
}

/**
 * Check if a split is a transfer-in (shares received from another investment account).
 * Reuses the detection logic from cost-basis.ts.
 */
function isTransferInSplit(
  split: {
    account_guid: string;
    quantity_num: bigint;
    quantity_denom: bigint;
    transaction?: {
      splits: Array<{
        account_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        account?: { commodity_guid?: string | null; account_type?: string | null; name?: string | null } | null;
      }>;
    } | null;
  },
  accountCommodityGuid: string
): boolean {
  const qty = toDecimalNumber(split.quantity_num, split.quantity_denom);
  if (qty <= 0) return false;

  const txSplits = split.transaction?.splits || [];
  return txSplits.some(
    s => s.account_guid !== split.account_guid &&
         s.account?.commodity_guid === accountCommodityGuid &&
         s.account?.account_type !== 'TRADING' &&
         toDecimalNumber(s.quantity_num, s.quantity_denom) < 0
  );
}

/**
 * Find the matching send split for a transfer-in.
 */
function findMatchingSendSplit(
  transferInSplit: {
    account_guid: string;
    transaction?: {
      splits: Array<{
        guid: string;
        account_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        lot_guid: string | null;
        account?: {
          guid?: string;
          name?: string | null;
          commodity_guid?: string | null;
          account_type?: string | null;
        } | null;
      }>;
    } | null;
  },
  accountCommodityGuid: string
) {
  const txSplits = transferInSplit.transaction?.splits || [];
  return txSplits.find(
    s => s.account_guid !== transferInSplit.account_guid &&
         s.account?.commodity_guid === accountCommodityGuid &&
         s.account?.account_type !== 'TRADING' &&
         toDecimalNumber(s.quantity_num, s.quantity_denom) < 0
  ) || null;
}

// ============================================
// Core Algorithm 1: Split Sells Across Lots
// ============================================

interface LotBalance {
  guid: string;
  shares: number;
}

/**
 * Split a sell across multiple lots when the sell qty exceeds a single lot's balance.
 * Creates new sub-splits in the database, each assigned to a different lot.
 * Returns the number of new splits created.
 *
 * IMPORTANT: Mutates `openLots` in place — each lot's `shares` field is decremented
 * as sells are allocated. The caller MUST reuse the same array across multiple sell
 * calls to maintain correct running balances.
 */
export async function splitSellAcrossLots(
  sellSplit: {
    guid: string;
    tx_guid: string;
    account_guid: string;
    quantity_num: bigint;
    quantity_denom: bigint;
    value_num: bigint;
    value_denom: bigint;
    memo: string;
    action: string;
    reconcile_state: string;
    reconcile_date: Date | null;
  },
  openLots: LotBalance[],
  runId: string,
  tx: PrismaTx
): Promise<{ splitsCreated: number; warnings: string[] }> {
  const warnings: string[] = [];
  const totalSellQty = Math.abs(toDecimalNumber(sellSplit.quantity_num, sellSplit.quantity_denom));
  const totalSellValue = toDecimalNumber(sellSplit.value_num, sellSplit.value_denom);

  let remainingSellQty = totalSellQty;
  let isFirstAllocation = true;
  let splitsCreated = 0;
  const subSplitsCreated: string[] = [];

  for (const lot of openLots) {
    if (remainingSellQty <= 0.0001) break;
    if (lot.shares <= 0.0001) continue;

    const allocated = Math.min(lot.shares, remainingSellQty);

    if (isFirstAllocation && Math.abs(allocated - totalSellQty) < 0.0001) {
      // Whole sell fits in this lot — just assign the original split
      await tx.splits.update({
        where: { guid: sellSplit.guid },
        data: { lot_guid: lot.guid },
      });
      lot.shares -= allocated;
      remainingSellQty -= allocated;
    } else {
      // Create a sub-split for this allocation
      const proportion = allocated / totalSellQty;
      const subQty = fromDecimal(-allocated, Number(sellSplit.quantity_denom));
      const subVal = fromDecimal(totalSellValue * proportion, Number(sellSplit.value_denom));

      const subGuid = generateGuid();
      await tx.splits.create({
        data: {
          guid: subGuid,
          tx_guid: sellSplit.tx_guid,
          account_guid: sellSplit.account_guid,
          memo: sellSplit.memo,
          action: sellSplit.action,
          reconcile_state: sellSplit.reconcile_state,
          reconcile_date: sellSplit.reconcile_date,
          quantity_num: subQty.num,
          quantity_denom: subQty.denom,
          value_num: subVal.num,
          value_denom: subVal.denom,
          lot_guid: lot.guid,
        },
      });
      await tagEntity(subGuid, 'gnucash_web_generated', runId, tx);
      subSplitsCreated.push(subGuid);
      splitsCreated++;
      lot.shares -= allocated;
      remainingSellQty -= allocated;
    }

    isFirstAllocation = false;
  }

  // Handle the original sell split after sub-splitting
  if (subSplitsCreated.length > 0) {
    // Save original qty/val for revert
    await tagEntity(sellSplit.guid, 'gnucash_web_original_qty',
      `${sellSplit.quantity_num}/${sellSplit.quantity_denom}`, tx);
    await tagEntity(sellSplit.guid, 'gnucash_web_original_val',
      `${sellSplit.value_num}/${sellSplit.value_denom}`, tx);

    if (remainingSellQty < 0.0001) {
      // Fully consumed by sub-splits — delete the original
      await tx.splits.delete({ where: { guid: sellSplit.guid } });
    } else {
      // Partially consumed — update original to the unallocated remainder
      const remainQty = fromDecimal(-remainingSellQty, Number(sellSplit.quantity_denom));
      const remainProportion = remainingSellQty / totalSellQty;
      const remainVal = fromDecimal(totalSellValue * remainProportion, Number(sellSplit.value_denom));
      await tx.splits.update({
        where: { guid: sellSplit.guid },
        data: {
          quantity_num: remainQty.num,
          quantity_denom: remainQty.denom,
          value_num: remainVal.num,
          value_denom: remainVal.denom,
          // lot_guid stays null — unassigned remainder
        },
      });
    }
  }

  if (remainingSellQty > 0.0001) {
    warnings.push(
      `Sell of ${remainingSellQty.toFixed(4)} shares could not be fully allocated to lots`
    );
  }

  // Transaction balance invariant: sum of all split values must equal zero
  if (subSplitsCreated.length > 0) {
    const allTxSplits = await tx.splits.findMany({ where: { tx_guid: sellSplit.tx_guid } });
    const balance = allTxSplits.reduce(
      (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom), 0
    );
    if (Math.abs(balance) > 0.01) {
      throw new Error(
        `Transaction ${sellSplit.tx_guid} is unbalanced after sell splitting: ${balance}`
      );
    }
  }

  return { splitsCreated, warnings };
}

// ============================================
// Core Algorithm 2: Transfer Lot Linking
// ============================================

/**
 * Link a transfer-in split to a new lot with acquisition date metadata from the source lot.
 */
export async function linkTransferToLot(
  transferInSplit: {
    guid: string;
    account_guid: string;
    transaction?: {
      splits: Array<{
        guid: string;
        account_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        lot_guid: string | null;
        account?: {
          guid?: string;
          name?: string | null;
          commodity_guid?: string | null;
          account_type?: string | null;
        } | null;
      }>;
      post_date?: Date | null;
    } | null;
  },
  accountCommodityGuid: string,
  runId: string,
  tx: PrismaTx
): Promise<{ lotCreated: boolean; lotGuid: string }> {
  // Idempotency guard: skip if split is already assigned to a lot
  const currentSplit = await tx.splits.findUnique({
    where: { guid: transferInSplit.guid },
    select: { lot_guid: true },
  });
  if (currentSplit?.lot_guid) {
    return { lotCreated: false, lotGuid: currentSplit.lot_guid };
  }

  const sourceSplit = findMatchingSendSplit(transferInSplit, accountCommodityGuid);
  const sourceAccountName = sourceSplit?.account?.name || 'Unknown';

  // Create new lot in destination account
  const destLotGuid = generateGuid();
  await tx.lots.create({
    data: {
      guid: destLotGuid,
      account_guid: transferInSplit.account_guid,
      is_closed: 0,
    },
  });
  await tagEntity(destLotGuid, 'title', `Transfer from ${sourceAccountName}`, tx);
  await tagEntity(destLotGuid, 'gnucash_web_generated', runId, tx);

  // If source has a lot, copy acquisition date metadata
  if (sourceSplit?.lot_guid) {
    // Get the source lot's earliest split date (acquisition date)
    const sourceLotSplits = await tx.splits.findMany({
      where: { lot_guid: sourceSplit.lot_guid },
      include: { transaction: { select: { post_date: true } } },
      orderBy: { transaction: { post_date: 'asc' } },
      take: 1,
    });
    const acquisitionDate = sourceLotSplits[0]?.transaction?.post_date;

    await tagEntity(destLotGuid, 'source_lot_guid', sourceSplit.lot_guid, tx);
    if (acquisitionDate) {
      await tagEntity(destLotGuid, 'acquisition_date', acquisitionDate.toISOString(), tx);
    }
  }

  // Assign the transfer-in split to the new lot
  await tx.splits.update({
    where: { guid: transferInSplit.guid },
    data: { lot_guid: destLotGuid },
  });

  return { lotCreated: true, lotGuid: destLotGuid };
}

// ============================================
// Core Algorithm 3: Auto Capital Gains
// ============================================

/**
 * Generate a capital gains transaction for a closed lot.
 * Uses GnuCash double-balance pattern: adjusting split in investment account
 * plus corresponding entry in the Income:Capital Gains account.
 */
export async function generateCapitalGains(
  lotGuid: string,
  accountGuid: string,
  runId: string,
  tx: PrismaTx
): Promise<{ generated: boolean; gainLoss: number; holdingPeriod: string }> {
  // Fetch lot splits
  const lotSplits = await tx.splits.findMany({
    where: { lot_guid: lotGuid },
    include: { transaction: { select: { post_date: true } } },
  });

  // Skip if lot already has a gains entry (zero-qty, non-zero value split)
  const existingGainsSplit = lotSplits.find(
    s => toDecimalNumber(s.quantity_num, s.quantity_denom) === 0 &&
         Math.abs(toDecimalNumber(s.value_num, s.value_denom)) > 0.0001
  );
  if (existingGainsSplit) {
    return { generated: false, gainLoss: 0, holdingPeriod: '' };
  }

  // Check if lot is actually closed (shares sum to ~0)
  const totalShares = lotSplits.reduce(
    (sum, s) => sum + toDecimalNumber(s.quantity_num, s.quantity_denom), 0
  );
  if (Math.abs(totalShares) > 0.0001) {
    return { generated: false, gainLoss: 0, holdingPeriod: '' };
  }

  // Classify tax status
  const taxStatus = await classifyAccountTax(accountGuid, tx);

  // Tax-exempt: skip gains generation, just close the lot
  if (taxStatus === 'TAX_EXEMPT') {
    await tx.lots.update({ where: { guid: lotGuid }, data: { is_closed: 1 } });
    return { generated: false, gainLoss: 0, holdingPeriod: '' };
  }

  // Compute gain/loss (sum of all split values in the lot)
  const gainLoss = lotSplits.reduce(
    (sum, s) => sum + toDecimalNumber(s.value_num, s.value_denom), 0
  );

  // Get dates for holding period classification
  const sortedSplits = [...lotSplits].sort(
    (a, b) => (a.transaction?.post_date?.getTime() || 0) - (b.transaction?.post_date?.getTime() || 0)
  );

  // Check for acquisition_date slot (from transfer linking)
  const acqDateSlot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: 'acquisition_date' },
    select: { string_val: true },
  });

  const openDate = acqDateSlot?.string_val
    ? new Date(acqDateSlot.string_val)
    : sortedSplits[0]?.transaction?.post_date || new Date();
  const closeDate = sortedSplits[sortedSplits.length - 1]?.transaction?.post_date || new Date();

  const holdingPeriod = classifyHoldingPeriod(openDate, closeDate);

  // Get account info for currency resolution
  const account = await tx.accounts.findUnique({
    where: { guid: accountGuid },
    select: { parent_guid: true },
  });
  if (!account?.parent_guid) {
    throw new Error(`Account ${accountGuid} has no parent — cannot determine currency`);
  }

  const parentAccount = await tx.accounts.findUnique({
    where: { guid: account.parent_guid },
    select: { commodity_guid: true, commodity_scu: true },
  });
  if (!parentAccount?.commodity_guid) {
    throw new Error(`Parent account of ${accountGuid} has no commodity — cannot determine currency`);
  }
  const currencyGuid = parentAccount.commodity_guid;
  const currencyScu = parentAccount.commodity_scu || 100;

  // Get book root for findOrCreateAccount
  const book = await tx.books.findFirst({ select: { root_account_guid: true } });
  if (!book) throw new Error('No book found');

  // Determine gains account path
  const gainsAccountPath = taxStatus === 'TAX_DEFERRED'
    ? 'Income:Capital Gains:Tax-Deferred'
    : `Income:Capital Gains:${holdingPeriod}`;

  const gainsAccountGuid = await findOrCreateAccount(
    gainsAccountPath, book.root_account_guid, currencyGuid, tx
  );

  // Get the lot title for the description
  const titleSlot = await tx.slots.findFirst({
    where: { obj_guid: lotGuid, name: 'title' },
    select: { string_val: true },
  });
  const lotTitle = titleSlot?.string_val || 'Lot';
  const gainOrLoss = gainLoss >= 0 ? 'Gain' : 'Loss';
  const description = `Realized ${holdingPeriod} ${gainOrLoss}: ${lotTitle}`;

  // Create the gains transaction
  const txGuid = generateGuid();
  const now = new Date();
  await tx.transactions.create({
    data: {
      guid: txGuid,
      currency_guid: currencyGuid,
      num: '',
      post_date: closeDate,
      enter_date: now,
      description,
    },
  });

  // Adjusting split in investment account (zero shares, negates the gain/loss)
  const adjustVal = fromDecimal(-gainLoss, currencyScu);
  const adjustGuid = generateGuid();
  await tx.splits.create({
    data: {
      guid: adjustGuid,
      tx_guid: txGuid,
      account_guid: accountGuid,
      memo: '',
      action: '',
      reconcile_state: 'n',
      reconcile_date: null,
      quantity_num: 0n,
      quantity_denom: 1n,
      value_num: adjustVal.num,
      value_denom: adjustVal.denom,
      lot_guid: lotGuid,
    },
  });

  // Corresponding entry in the gains account
  const gainsVal = fromDecimal(gainLoss, currencyScu);
  const gainsGuid = generateGuid();
  await tx.splits.create({
    data: {
      guid: gainsGuid,
      tx_guid: txGuid,
      account_guid: gainsAccountGuid,
      memo: '',
      action: '',
      reconcile_state: 'n',
      reconcile_date: null,
      quantity_num: 0n,
      quantity_denom: 1n,
      value_num: gainsVal.num,
      value_denom: gainsVal.denom,
      lot_guid: null,
    },
  });

  // Tag everything for revertability
  await tagEntity(txGuid, 'gnucash_web_generated', runId, tx);
  await tagEntity(adjustGuid, 'gnucash_web_generated', runId, tx);
  await tagEntity(gainsGuid, 'gnucash_web_generated', runId, tx);

  // Mark lot as closed
  await tx.lots.update({ where: { guid: lotGuid }, data: { is_closed: 1 } });

  return { generated: true, gainLoss, holdingPeriod };
}
```

- [ ] **Step 2: Write comprehensive tests for lot-scrub.ts**

Create `src/lib/__tests__/lot-scrub.test.ts` with tests covering all codepaths from the eng review test diagram. This file will be large — mock Prisma and test each algorithm independently.

Key test cases to cover:
- `splitSellAcrossLots`: A1 (fits in one lot), A2 (spans 2 lots), A3 (spans 3+), A4 (exceeds all), A5 (no lots)
- `linkTransferToLot`: B1 (source has lot), B2 (source has no lot)
- `generateCapitalGains`: C1 (taxable ST), C2 (tax-deferred), C3 (tax-exempt), C4 (pre-existing gains), C5/C6 (ST/LT classification)
- `classifyAccountTax`: various hierarchy patterns
- `classifyHoldingPeriod`: edge cases around 1 year

- [ ] **Step 3: Run tests**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run src/lib/__tests__/lot-scrub.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/lib/lot-scrub.ts src/lib/__tests__/lot-scrub.test.ts
git commit -m "feat: add lot scrub engine — sell splitting, transfer linking, capital gains generation"
```

---

### Task 4: Integrate scrub engine into lot-assignment.ts

**Files:**
- Modify: `src/lib/lot-assignment.ts`

- [ ] **Step 1: Refactor `assignWithStrategy` to use scrub engine for sells**

Replace the sell assignment loop (lines 141-159) in `assignWithStrategy` to call `splitSellAcrossLots` instead of the simple single-lot assignment. Also add transfer detection before buy processing.

Key changes to `lot-assignment.ts`:
1. Import scrub functions: `import { splitSellAcrossLots, linkTransferToLot, generateCapitalGains } from './lot-scrub';`
2. Add `runId` parameter generation at the start of `assignWithStrategy`
3. Before assigning buys: detect transfer-in splits and call `linkTransferToLot`
4. For sells: call `splitSellAcrossLots` instead of the current simple assignment
5. After all sells assigned: check for closed lots and call `generateCapitalGains`
6. Update `AutoAssignResult` interface to include new fields from `ScrubResult`
7. Add `scrubAllAccounts` export function that handles topological ordering

- [ ] **Step 2: Add `scrubAllAccounts` function**

This function:
1. Fetches all STOCK/MUTUAL accounts in the book
2. Builds a transfer dependency graph (which accounts have transfer-in splits from which source accounts)
3. Topological-sorts to determine scrub order
4. Scrubs each account in a per-account `prisma.$transaction()`
5. Collects and returns aggregate results

- [ ] **Step 3: Extend `clearLotAssignments` to clean up scrub artifacts**

Update the slot deletion to include `source_lot_guid`, `acquisition_date`, `gnucash_web_generated`, `gnucash_web_original_qty`, and `gnucash_web_original_val`. Also:
1. Delete auto-generated gains transactions (identified by having `gnucash_web_generated` slots on the transaction)
2. Delete auto-generated sub-splits (identified by having `gnucash_web_generated` slots on the split)
3. Restore original sell splits from `gnucash_web_original_qty`/`gnucash_web_original_val` slot data before deleting those slots
4. Clean up all slot types for the lot GUIDs being deleted

- [ ] **Step 4: Add `revertScrubRun` function**

Takes a `runId` and:
1. Finds all entities tagged with that `run_id`
2. Deletes created splits and transactions
3. Restores original split quantities (stored in a `gnucash_web_original_qty` slot before modification)
4. Unassigns splits from lots
5. Deletes empty lots

- [ ] **Step 5: Run build + existing tests**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run && npm run build 2>&1 | tail -5`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/lib/lot-assignment.ts
git commit -m "feat: integrate scrub engine into lot assignment — sell splitting, transfer linking, gains generation"
```

---

### Task 5: Extend LotSummary and lots.ts

**Files:**
- Modify: `src/lib/lots.ts`

- [ ] **Step 1: Add `sourceLotGuid` and `acquisitionDate` to `LotSummary`**

Add these fields to the `LotSummary` interface. In `getAccountLots()`, after fetching lot titles, also fetch `source_lot_guid` and `acquisition_date` slots and include them in the summary.

- [ ] **Step 2: Use `acquisitionDate` for holding period when available**

In the holding period calculation, prefer the `acquisition_date` slot value (from transfer linking) over the lot's earliest split date.

- [ ] **Step 3: Run build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/lib/lots.ts
git commit -m "feat: extend LotSummary with transfer source metadata and acquisition date"
```

---

### Task 6: API routes — scrub-all, revert, extend auto-assign

**Files:**
- Create: `src/app/api/lots/scrub-all/route.ts`
- Create: `src/app/api/accounts/[guid]/lots/revert/route.ts`
- Modify: `src/app/api/accounts/[guid]/lots/auto-assign/route.ts`
- Modify: `src/app/api/accounts/[guid]/lots/clear-assign/route.ts`

- [ ] **Step 1: Create scrub-all API route**

`src/app/api/lots/scrub-all/route.ts`:
- POST endpoint accepting `{ method: 'fifo' | 'lifo' | 'average' }`
- Requires 'edit' role
- Calls `scrubAllAccounts()` from lot-assignment.ts
- Returns aggregate ScrubResult

- [ ] **Step 2: Create revert API route**

`src/app/api/accounts/[guid]/lots/revert/route.ts`:
- POST endpoint accepting `{ runId: string }`
- Requires 'edit' role
- Calls `revertScrubRun()` from lot-assignment.ts
- Returns count of reverted entities

- [ ] **Step 3: Extend auto-assign route to return scrub results**

Update `src/app/api/accounts/[guid]/lots/auto-assign/route.ts` to return the full `ScrubResult` (including `gainsTransactions`, `totalRealizedGain`, `runId`, `warnings`).

- [ ] **Step 4: Extend clear-assign route**

Update `src/app/api/accounts/[guid]/lots/clear-assign/route.ts` to also report gains transactions deleted.

- [ ] **Step 5: Run build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run build 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/app/api/lots/scrub-all/route.ts src/app/api/accounts/\[guid\]/lots/revert/route.ts src/app/api/accounts/\[guid\]/lots/auto-assign/route.ts src/app/api/accounts/\[guid\]/lots/clear-assign/route.ts
git commit -m "feat: add scrub-all and revert API routes, extend auto-assign response"
```

---

### Task 7: UI — AutoAssignDialog summary, LotViewer transfer info

**Files:**
- Modify: `src/components/ledger/AutoAssignDialog.tsx`
- Modify: `src/components/ledger/LotViewer.tsx`

- [ ] **Step 1: Extend AutoAssignDialog to show post-scrub summary**

After a successful auto-assign, show:
- Number of gains transactions created
- Total realized gain/loss
- Any warnings (e.g., sells that couldn't be fully allocated)
- The `runId` for potential revert
- A "Revert" button that calls the revert API

- [ ] **Step 2: Extend LotViewer to show transfer source info**

For lots with `sourceLotGuid`, show a badge/label indicating "Transferred from [source account]" with the original acquisition date.

For lots with gains transactions (zero-qty splits), show the realized gain/loss amount and ST/LT classification.

- [ ] **Step 3: Run build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/components/ledger/AutoAssignDialog.tsx src/components/ledger/LotViewer.tsx
git commit -m "feat: show scrub summary in AutoAssignDialog, transfer info in LotViewer"
```

---

### Task 8: UI — Scrub All button on Investments page

**Files:**
- Create: `src/components/investments/ScrubAllButton.tsx`
- Modify: `src/app/(main)/investments/page.tsx`

- [ ] **Step 1: Create ScrubAllButton component**

`src/components/investments/ScrubAllButton.tsx`:
- Button that opens a confirmation dialog
- Method selector (FIFO/LIFO/Average)
- Calls POST `/api/lots/scrub-all`
- Shows progress/results in a summary panel
- Includes "Revert Last Scrub" button

- [ ] **Step 2: Add ScrubAllButton to investments page**

Import and render `<ScrubAllButton />` on the investments page, alongside the existing portfolio summary cards.

- [ ] **Step 3: Run build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add src/components/investments/ScrubAllButton.tsx src/app/\(main\)/investments/page.tsx
git commit -m "feat: add Scrub All Accounts button on investments page"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

The Testing section was already updated in the main worktree. Ensure the worktree has the same update. Also add to the Architecture section:

Under "Key Libraries (src/lib/)":
```
- `lot-scrub.ts` - GnuCash-compatible lot scrub engine (sell splitting, transfer linking, capital gains)
- `lot-assignment.ts` - Auto-assign algorithms (FIFO/LIFO/average) with scrub engine integration
```

- [ ] **Step 2: Commit**

```bash
cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with testing framework and lot scrub engine documentation"
```

---

### Task 10: Final validation and cleanup

- [ ] **Step 1: Run full test suite**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run production build**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run lint**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && npm run lint`
Expected: No errors

- [ ] **Step 4: Review git log**

Run: `cd /home/justin/projects/gnucash-web/.worktrees/feat-investment-lots && git log --oneline`
Verify: Clean commit history with descriptive messages
