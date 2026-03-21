# Lot Assignment + Tax Harvesting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lot assignment UI (manual + auto-assign), lot management APIs, and a tax-loss harvesting dashboard to the existing GnuCash Web investment ledger.

**Architecture:** New `src/lib/lot-assignment.ts` service for auto-assign (FIFO/LIFO/average), wash sale detection, and clear-assign operations (separated from `src/lib/lots.ts` for clarity — design doc suggested extending lots.ts, but a separate file is cleaner for this volume of code). New API routes under `/api/accounts/[guid]/lots/` and `/api/splits/[guid]/lot/`. New UI components (`LotAssignmentPopover`, `AutoAssignDialog`) wired into `AccountLedger.tsx`. New tax harvesting report page at `/reports/tax_harvesting/`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 7.3 (`prisma.$transaction()` for atomicity), Tailwind CSS 4, `@tanstack/react-query` for data fetching.

**Design doc:** `docs/designs/lot-assignment-tax-harvesting.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/lot-assignment.ts` | Auto-assign algorithm (FIFO/LIFO/average), clear-assign logic, wash sale detection |
| `src/app/api/accounts/[guid]/lots/auto-assign/route.ts` | POST: run auto-assign for an account |
| `src/app/api/accounts/[guid]/lots/clear-assign/route.ts` | POST: remove all lot assignments for an account |
| `src/app/api/accounts/[guid]/lots/route.ts` | POST handler (lot creation) — extend existing file |
| `src/app/api/splits/[guid]/lot/route.ts` | PATCH: assign/unassign a single split to/from a lot |
| `src/app/api/reports/tax-harvesting/route.ts` | GET: tax harvesting dashboard data |
| `src/app/(main)/reports/tax_harvesting/page.tsx` | Tax harvesting report page |
| `src/components/ledger/LotAssignmentPopover.tsx` | Per-split lot assignment dropdown popover |
| `src/components/ledger/AutoAssignDialog.tsx` | Modal dialog for auto-assign with method selection + preview |

### Modified Files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `lot_assignment_method` column to `gnucash_web_account_preferences` |
| `src/components/ledger/LotViewer.tsx` | Add unlinked splits section with count + quick-assign button (uses existing `getFreeSplits()` via `?includeFreeSplits=true`) |
| `src/components/AccountLedger.tsx` | Wire LotAssignmentPopover into split rows, add auto-assign toolbar button |
| `src/app/api/accounts/[guid]/preferences/route.ts` | Accept `lot_assignment_method` in PATCH body |
| `src/lib/reports/types.ts` | Add `TAX_HARVESTING` to `ReportType` enum |

---

## Task 1: Schema — Add `lot_assignment_method` to Account Preferences

**Files:**
- Modify: `prisma/schema.prisma:519-524`
- Modify: `src/app/api/accounts/[guid]/preferences/route.ts`

- [ ] **Step 1: Add column to Prisma schema**

In `prisma/schema.prisma`, update the `gnucash_web_account_preferences` model:

```prisma
model gnucash_web_account_preferences {
  account_guid           String  @id @db.VarChar(32)
  cost_basis_method      String? @db.VarChar(20)
  lot_assignment_method  String? @db.VarChar(20) // 'fifo', 'lifo', 'average'

  @@map("gnucash_web_account_preferences")
}
```

- [ ] **Step 2: Run Prisma migration**

Run: `npx prisma db push`
Expected: Schema synced, no errors.

- [ ] **Step 3: Update preferences API to accept `lot_assignment_method`**

In `src/app/api/accounts/[guid]/preferences/route.ts`:

Add `lot_assignment_method` to the PATCH handler alongside `cost_basis_method`. Add validation:

```typescript
const VALID_LOT_ASSIGNMENT_METHODS = ['fifo', 'lifo', 'average'];

// Inside PATCH handler, after cost_basis_method validation:
const { cost_basis_method, lot_assignment_method } = body;

if (lot_assignment_method !== null && lot_assignment_method !== undefined &&
    !VALID_LOT_ASSIGNMENT_METHODS.includes(lot_assignment_method)) {
  return NextResponse.json(
    { error: `Invalid lot_assignment_method. Must be one of: ${VALID_LOT_ASSIGNMENT_METHODS.join(', ')}` },
    { status: 400 }
  );
}
```

Update the SQL to include `lot_assignment_method`. Preserve the existing direct-set behavior (no COALESCE — users must be able to clear a preference by setting it to `null`):

```typescript
await prisma.$executeRaw`
  INSERT INTO gnucash_web_account_preferences (account_guid, cost_basis_method, lot_assignment_method)
  VALUES (${guid}, ${cost_basis_method ?? null}, ${lot_assignment_method ?? null})
  ON CONFLICT (account_guid)
  DO UPDATE SET
    cost_basis_method = ${cost_basis_method ?? null},
    lot_assignment_method = ${lot_assignment_method ?? null}
`;
```

**Note:** This means a PATCH that only sends `{ "lot_assignment_method": "fifo" }` will also set `cost_basis_method` to null. To avoid this, the handler should read the existing row first and merge only the fields present in the request body. Alternatively, build the SET clause dynamically based on which fields were provided. The simplest approach: only update fields that are present in the request body (check `'cost_basis_method' in body` rather than checking the value).

Update the GET handler to also return `lot_assignment_method`:

```typescript
const rows = await prisma.$queryRaw<{ account_guid: string; cost_basis_method: string | null; lot_assignment_method: string | null }[]>`
  SELECT account_guid, cost_basis_method, lot_assignment_method
  FROM gnucash_web_account_preferences
  WHERE account_guid = ${guid}
`;
```

- [ ] **Step 4: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma src/app/api/accounts/\[guid\]/preferences/route.ts
git commit -m "feat: add lot_assignment_method to account preferences schema + API"
```

---

## Task 2: Single Split Lot Assignment API

**Files:**
- Create: `src/app/api/splits/[guid]/lot/route.ts`

- [ ] **Step 1: Create the split lot assignment endpoint**

Create `src/app/api/splits/[guid]/lot/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { generateGuid } from '@/lib/gnucash';

/**
 * PATCH /api/splits/{guid}/lot
 * Assign or unassign a split to/from a lot.
 *
 * Body:
 *   { lot_guid: string }        — assign to existing lot
 *   { lot_guid: null }           — unassign from lot
 *   { lot_guid: "new", title?: string } — create new lot and assign
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: splitGuid } = await params;
    const body = await request.json();
    const { lot_guid, title } = body;

    // Verify split exists
    const split = await prisma.splits.findUnique({
      where: { guid: splitGuid },
      select: { guid: true, account_guid: true, lot_guid: true },
    });
    if (!split) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    // Verify split's account belongs to active book (security check)
    if (!await isAccountInActiveBook(split.account_guid)) {
      return NextResponse.json({ error: 'Split not found' }, { status: 404 });
    }

    let targetLotGuid: string | null = null;

    if (lot_guid === null) {
      // Unassign
      targetLotGuid = null;
    } else if (lot_guid === 'new') {
      // Create new lot
      const newGuid = generateGuid();
      await prisma.$transaction(async (tx) => {
        await tx.lots.create({
          data: {
            guid: newGuid,
            account_guid: split.account_guid,
            is_closed: 0,
          },
        });
        // Store title in slots table (GnuCash convention)
        if (title) {
          await tx.slots.create({
            data: {
              obj_guid: newGuid,
              name: 'title',
              slot_type: 4, // STRING type
              string_val: title,
            },
          });
        }
      });
      targetLotGuid = newGuid;
    } else {
      // Assign to existing lot — validate lot belongs to same account
      const lot = await prisma.lots.findUnique({
        where: { guid: lot_guid },
        select: { guid: true, account_guid: true },
      });
      if (!lot) {
        return NextResponse.json({ error: 'Lot not found' }, { status: 404 });
      }
      if (lot.account_guid !== split.account_guid) {
        return NextResponse.json(
          { error: 'Split and lot must belong to the same account' },
          { status: 400 }
        );
      }
      targetLotGuid = lot_guid;
    }

    // Update split
    await prisma.splits.update({
      where: { guid: splitGuid },
      data: { lot_guid: targetLotGuid },
    });

    return NextResponse.json({
      split_guid: splitGuid,
      lot_guid: targetLotGuid,
    });
  } catch (error) {
    console.error('Error assigning split to lot:', error);
    return NextResponse.json(
      { error: 'Failed to assign split to lot' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/splits/\[guid\]/lot/route.ts
git commit -m "feat: add split-to-lot assignment API endpoint"
```

---

## Task 3: Lot Creation API (POST on existing route)

**Files:**
- Modify: `src/app/api/accounts/[guid]/lots/route.ts`

- [ ] **Step 1: Add POST handler for lot creation**

Add to `src/app/api/accounts/[guid]/lots/route.ts`:

```typescript
import { generateGuid } from '@/lib/gnucash';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = await request.json();
    const { title } = body;

    const lotGuid = generateGuid();

    await prisma.$transaction(async (tx) => {
      await tx.lots.create({
        data: {
          guid: lotGuid,
          account_guid: accountGuid,
          is_closed: 0,
        },
      });
      if (title) {
        await tx.slots.create({
          data: {
            obj_guid: lotGuid,
            name: 'title',
            slot_type: 4,
            string_val: title,
          },
        });
      }
    });

    return NextResponse.json({ guid: lotGuid, title: title || null }, { status: 201 });
  } catch (error) {
    console.error('Error creating lot:', error);
    return NextResponse.json({ error: 'Failed to create lot' }, { status: 500 });
  }
}
```

Add `import prisma from '@/lib/prisma';` and `import { generateGuid } from '@/lib/gnucash';` at the top (prisma may already be imported via lots.ts, but the route uses the direct prisma import pattern).

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/accounts/\[guid\]/lots/route.ts
git commit -m "feat: add POST handler for lot creation"
```

---

## Task 4: Auto-Assign Service Logic

**Files:**
- Create: `src/lib/lot-assignment.ts`

- [ ] **Step 1: Create lot-assignment service**

Create `src/lib/lot-assignment.ts`:

```typescript
/**
 * Lot Assignment Service
 *
 * Implements auto-assign algorithms (FIFO, LIFO, average) and
 * bulk operations (clear-assign) for lot management.
 */

import prisma from './prisma';
import { generateGuid, toDecimal as toDecimalString } from './gnucash';

function toDecimal(num: bigint, denom: bigint): number {
  return parseFloat(toDecimalString(num, denom));
}

interface SplitForAssignment {
  guid: string;
  tx_guid: string;
  account_guid: string;
  quantity_num: bigint;
  quantity_denom: bigint;
  value_num: bigint;
  value_denom: bigint;
  post_date: Date | null;
  lot_guid: string | null;
}

export interface AutoAssignResult {
  lotsCreated: number;
  splitsAssigned: number;
  method: string;
}

/**
 * Get unassigned splits for an account, sorted by date.
 */
async function getUnassignedSplits(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<SplitForAssignment[]> {
  const splits = await tx.splits.findMany({
    where: {
      account_guid: accountGuid,
      lot_guid: null,
    },
    include: {
      transaction: {
        select: { post_date: true },
      },
    },
    orderBy: { transaction: { post_date: 'asc' } },
  });

  return splits.map(s => ({
    guid: s.guid,
    tx_guid: s.tx_guid,
    account_guid: s.account_guid,
    quantity_num: s.quantity_num,
    quantity_denom: s.quantity_denom,
    value_num: s.value_num,
    value_denom: s.value_denom,
    post_date: s.transaction?.post_date ?? null,
    lot_guid: s.lot_guid,
  }));
}

/**
 * Create a new lot in the database and return its GUID.
 */
async function createLot(
  accountGuid: string,
  title: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<string> {
  const guid = generateGuid();
  await tx.lots.create({
    data: {
      guid,
      account_guid: accountGuid,
      is_closed: 0,
    },
  });
  await tx.slots.create({
    data: {
      obj_guid: guid,
      name: 'title',
      slot_type: 4,
      string_val: title,
    },
  });
  return guid;
}

/**
 * Auto-assign unassigned splits to lots using FIFO method.
 * Each buy creates a new lot. Sells are assigned to the earliest open lot.
 */
async function assignFIFO(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<AutoAssignResult> {
  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) return { lotsCreated: 0, splitsAssigned: 0, method: 'fifo' };

  // Separate buys (positive qty) and sells (negative qty)
  const buys = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) > 0);
  const sells = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) < 0);

  // Sort buys chronologically (FIFO)
  buys.sort((a, b) => (a.post_date?.getTime() || 0) - (b.post_date?.getTime() || 0));

  let lotsCreated = 0;

  // Get existing open lots (ordered by date for FIFO)
  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: { splits: { select: { quantity_num: true, quantity_denom: true } } },
  });

  // Build lot tracking: lot_guid -> remaining shares
  const lotShareMap = new Map<string, number>();
  const lotOrder: string[] = []; // ordered by creation/open date

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimal(s.quantity_num, s.quantity_denom), 0
    );
    if (Math.abs(shares) > 0.0001) {
      lotShareMap.set(lot.guid, shares);
      lotOrder.push(lot.guid);
    }
  }

  // Each buy creates a new lot
  for (const buy of buys) {
    const dateStr = buy.post_date
      ? buy.post_date.toISOString().split('T')[0]
      : 'Unknown';
    const title = `Buy ${dateStr}`;
    const lotGuid = await createLot(accountGuid, title, tx);
    lotsCreated++;

    await tx.splits.update({
      where: { guid: buy.guid },
      data: { lot_guid: lotGuid },
    });

    const qty = toDecimal(buy.quantity_num, buy.quantity_denom);
    lotShareMap.set(lotGuid, qty);
    lotOrder.push(lotGuid);
  }

  // Assign sells to earliest lot with remaining shares (FIFO)
  for (const sell of sells) {
    // Find first lot with positive shares
    const targetLotGuid = lotOrder.find(g => (lotShareMap.get(g) || 0) > 0.0001);
    if (targetLotGuid) {
      await tx.splits.update({
        where: { guid: sell.guid },
        data: { lot_guid: targetLotGuid },
      });
      const sellQty = toDecimal(sell.quantity_num, sell.quantity_denom); // negative
      lotShareMap.set(targetLotGuid, (lotShareMap.get(targetLotGuid) || 0) + sellQty);
    } else {
      // No lot with positive shares — assign to last lot (allows negative, per design)
      const lastLot = lotOrder[lotOrder.length - 1];
      if (lastLot) {
        await tx.splits.update({
          where: { guid: sell.guid },
          data: { lot_guid: lastLot },
        });
      }
    }
  }

  return {
    lotsCreated,
    splitsAssigned: splits.length,
    method: 'fifo',
  };
}

/**
 * Auto-assign using LIFO method.
 * Each buy creates a new lot. Sells are assigned to the most recent open lot.
 */
async function assignLIFO(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<AutoAssignResult> {
  const splits = await getUnassignedSplits(accountGuid, tx);
  if (splits.length === 0) return { lotsCreated: 0, splitsAssigned: 0, method: 'lifo' };

  const buys = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) > 0);
  const sells = splits.filter(s => toDecimal(s.quantity_num, s.quantity_denom) < 0);

  buys.sort((a, b) => (a.post_date?.getTime() || 0) - (b.post_date?.getTime() || 0));

  let lotsCreated = 0;

  const existingLots = await tx.lots.findMany({
    where: { account_guid: accountGuid, is_closed: 0 },
    include: { splits: { select: { quantity_num: true, quantity_denom: true } } },
  });

  const lotShareMap = new Map<string, number>();
  const lotOrder: string[] = [];

  for (const lot of existingLots) {
    const shares = lot.splits.reduce(
      (sum, s) => sum + toDecimal(s.quantity_num, s.quantity_denom), 0
    );
    if (Math.abs(shares) > 0.0001) {
      lotShareMap.set(lot.guid, shares);
      lotOrder.push(lot.guid);
    }
  }

  for (const buy of buys) {
    const dateStr = buy.post_date
      ? buy.post_date.toISOString().split('T')[0]
      : 'Unknown';
    const title = `Buy ${dateStr}`;
    const lotGuid = await createLot(accountGuid, title, tx);
    lotsCreated++;

    await tx.splits.update({
      where: { guid: buy.guid },
      data: { lot_guid: lotGuid },
    });

    const qty = toDecimal(buy.quantity_num, buy.quantity_denom);
    lotShareMap.set(lotGuid, qty);
    lotOrder.push(lotGuid);
  }

  // Assign sells to MOST RECENT lot with remaining shares (LIFO = reverse order)
  for (const sell of sells) {
    const reversedOrder = [...lotOrder].reverse();
    const targetLotGuid = reversedOrder.find(g => (lotShareMap.get(g) || 0) > 0.0001);
    if (targetLotGuid) {
      await tx.splits.update({
        where: { guid: sell.guid },
        data: { lot_guid: targetLotGuid },
      });
      const sellQty = toDecimal(sell.quantity_num, sell.quantity_denom);
      lotShareMap.set(targetLotGuid, (lotShareMap.get(targetLotGuid) || 0) + sellQty);
    } else {
      const lastLot = lotOrder[lotOrder.length - 1];
      if (lastLot) {
        await tx.splits.update({
          where: { guid: sell.guid },
          data: { lot_guid: lastLot },
        });
      }
    }
  }

  return {
    lotsCreated,
    splitsAssigned: splits.length,
    method: 'lifo',
  };
}

/**
 * Auto-assign using average method.
 * Creates separate lots per buy (preserves granularity), but the UI
 * will display averaged cost basis across all open lots.
 */
async function assignAverage(
  accountGuid: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<AutoAssignResult> {
  // Average method: each buy gets its own lot (same as FIFO for lot creation).
  // Sells go to the earliest lot (same allocation as FIFO).
  // The difference is in *display*: the UI shows averaged cost per share.
  return assignFIFO(accountGuid, tx);
}

/**
 * Run auto-assignment for an account.
 */
export async function autoAssignLots(
  accountGuid: string,
  method: 'fifo' | 'lifo' | 'average'
): Promise<AutoAssignResult> {
  return prisma.$transaction(async (tx) => {
    switch (method) {
      case 'fifo':
        return assignFIFO(accountGuid, tx);
      case 'lifo':
        return assignLIFO(accountGuid, tx);
      case 'average':
        return assignAverage(accountGuid, tx);
      default:
        throw new Error(`Unknown assignment method: ${method}`);
    }
  });
}

/**
 * Clear all lot assignments for an account.
 * Sets lot_guid = null on all splits, then deletes empty lots.
 */
export async function clearLotAssignments(
  accountGuid: string
): Promise<{ splitsUnassigned: number; lotsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    // Unassign all splits in this account
    const updateResult = await tx.splits.updateMany({
      where: { account_guid: accountGuid, lot_guid: { not: null } },
      data: { lot_guid: null },
    });

    // Find and delete lots that now have zero splits
    const emptyLots = await tx.lots.findMany({
      where: { account_guid: accountGuid },
      include: { _count: { select: { splits: true } } },
    });

    const lotsToDelete = emptyLots.filter(l => l._count.splits === 0);

    if (lotsToDelete.length > 0) {
      const lotGuids = lotsToDelete.map(l => l.guid);
      // Delete associated slot entries (titles)
      await tx.slots.deleteMany({
        where: { obj_guid: { in: lotGuids }, name: 'title' },
      });
      // Delete the lots
      await tx.lots.deleteMany({
        where: { guid: { in: lotGuids } },
      });
    }

    return {
      splitsUnassigned: updateResult.count,
      lotsDeleted: lotsToDelete.length,
    };
  });
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds (service is not yet imported anywhere, but should type-check).

- [ ] **Step 3: Commit**

```bash
git add src/lib/lot-assignment.ts
git commit -m "feat: add lot auto-assign service with FIFO/LIFO/average methods"
```

---

## Task 5: Auto-Assign and Clear-Assign API Routes

**Files:**
- Create: `src/app/api/accounts/[guid]/lots/auto-assign/route.ts`
- Create: `src/app/api/accounts/[guid]/lots/clear-assign/route.ts`

- [ ] **Step 1: Create auto-assign endpoint**

Create `src/app/api/accounts/[guid]/lots/auto-assign/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { autoAssignLots } from '@/lib/lot-assignment';

const VALID_METHODS = ['fifo', 'lifo', 'average'] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = await request.json();
    const method = body.method || 'fifo';

    if (!VALID_METHODS.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${VALID_METHODS.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await autoAssignLots(accountGuid, method);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error auto-assigning lots:', error);
    return NextResponse.json(
      { error: 'Failed to auto-assign lots' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Create clear-assign endpoint**

Create `src/app/api/accounts/[guid]/lots/clear-assign/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { clearLotAssignments } from '@/lib/lot-assignment';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const result = await clearLotAssignments(accountGuid);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error clearing lot assignments:', error);
    return NextResponse.json(
      { error: 'Failed to clear lot assignments' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/accounts/\[guid\]/lots/auto-assign/route.ts src/app/api/accounts/\[guid\]/lots/clear-assign/route.ts
git commit -m "feat: add auto-assign and clear-assign API endpoints"
```

---

## Task 6: LotAssignmentPopover Component

**Files:**
- Create: `src/components/ledger/LotAssignmentPopover.tsx`

- [ ] **Step 1: Create the popover component**

Create `src/components/ledger/LotAssignmentPopover.tsx`:

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import { formatCurrency } from '@/lib/format';

interface LotOption {
  guid: string;
  title: string;
  totalShares: number;
  isClosed: boolean;
}

interface LotAssignmentPopoverProps {
  splitGuid: string;
  currentLotGuid: string | null;
  accountGuid: string;
  lots: LotOption[];
  currencyMnemonic: string;
  onAssign: (splitGuid: string, lotGuid: string | null) => Promise<void>;
  onCreateAndAssign: (splitGuid: string, title: string) => Promise<void>;
}

export default function LotAssignmentPopover({
  splitGuid,
  currentLotGuid,
  accountGuid,
  lots,
  currencyMnemonic,
  onAssign,
  onCreateAndAssign,
}: LotAssignmentPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCreating(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleAssign = async (lotGuid: string | null) => {
    setLoading(true);
    try {
      await onAssign(splitGuid, lotGuid);
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setLoading(true);
    try {
      await onCreateAndAssign(splitGuid, newTitle.trim());
      setIsOpen(false);
      setIsCreating(false);
      setNewTitle('');
    } finally {
      setLoading(false);
    }
  };

  const currentLot = lots.find(l => l.guid === currentLotGuid);
  const openLots = lots.filter(l => !l.isClosed);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
          currentLotGuid
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            : 'border-border/50 bg-background-secondary/20 text-foreground-muted hover:bg-background-secondary/40'
        }`}
        title={currentLot ? `Assigned to: ${currentLot.title}` : 'Assign to lot'}
      >
        {currentLot ? currentLot.title : '+ Lot'}
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl">
          <div className="p-2 space-y-1">
            <div className="text-[10px] text-foreground-muted uppercase tracking-wider px-2 py-1">
              Assign to Lot
            </div>

            {/* Unassign option */}
            {currentLotGuid && (
              <button
                onClick={() => handleAssign(null)}
                disabled={loading}
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-background-secondary/40 text-rose-400 transition-colors"
              >
                Unassign
              </button>
            )}

            {/* Existing open lots */}
            {openLots.map(lot => (
              <button
                key={lot.guid}
                onClick={() => handleAssign(lot.guid)}
                disabled={loading || lot.guid === currentLotGuid}
                className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors ${
                  lot.guid === currentLotGuid
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'hover:bg-background-secondary/40 text-foreground'
                }`}
              >
                <span className="font-medium">{lot.title}</span>
                <span className="text-foreground-muted ml-1">
                  ({lot.totalShares.toFixed(2)} shares)
                </span>
              </button>
            ))}

            {/* Divider */}
            <div className="border-t border-border/50 my-1" />

            {/* Create new lot */}
            {isCreating ? (
              <div className="px-2 py-1 space-y-1">
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="Lot title..."
                  className="w-full px-2 py-1 text-xs bg-input-bg border border-border rounded text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setIsCreating(false); setNewTitle(''); }
                  }}
                />
                <div className="flex gap-1">
                  <button
                    onClick={handleCreate}
                    disabled={loading || !newTitle.trim()}
                    className="flex-1 px-2 py-1 text-xs bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => { setIsCreating(false); setNewTitle(''); }}
                    className="px-2 py-1 text-xs text-foreground-muted hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setIsCreating(true)}
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-background-secondary/40 text-cyan-400 transition-colors"
              >
                + New Lot
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/LotAssignmentPopover.tsx
git commit -m "feat: add LotAssignmentPopover component for per-split lot assignment"
```

---

## Task 7: AutoAssignDialog Component

**Files:**
- Create: `src/components/ledger/AutoAssignDialog.tsx`

- [ ] **Step 1: Create the auto-assign dialog**

Create `src/components/ledger/AutoAssignDialog.tsx`:

```tsx
'use client';

import { useState } from 'react';

interface AutoAssignDialogProps {
  accountGuid: string;
  freeSplitsCount: number;
  currentMethod: string | null;
  isOpen: boolean;
  onClose: () => void;
  onAssign: (method: 'fifo' | 'lifo' | 'average') => Promise<void>;
  onClearAll: () => Promise<void>;
}

const METHODS = [
  {
    value: 'fifo' as const,
    label: 'FIFO (First In, First Out)',
    description: 'Sells oldest shares first. Maximizes long-term capital gains treatment.',
  },
  {
    value: 'lifo' as const,
    label: 'LIFO (Last In, First Out)',
    description: 'Sells newest shares first. May minimize short-term gains.',
  },
  {
    value: 'average' as const,
    label: 'Average Cost',
    description: 'Each buy is a separate lot, but cost basis displays averaged across all open lots.',
  },
];

export default function AutoAssignDialog({
  accountGuid,
  freeSplitsCount,
  currentMethod,
  isOpen,
  onClose,
  onAssign,
  onClearAll,
}: AutoAssignDialogProps) {
  const [selectedMethod, setSelectedMethod] = useState<'fifo' | 'lifo' | 'average'>(
    (currentMethod as 'fifo' | 'lifo' | 'average') || 'fifo'
  );
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  if (!isOpen) return null;

  const handleAssign = async () => {
    setLoading(true);
    try {
      await onAssign(selectedMethod);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setLoading(true);
    try {
      await onClearAll();
      setConfirmClear(false);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-foreground">Auto-Assign Lots</h2>
            <button
              onClick={onClose}
              className="text-foreground-muted hover:text-foreground transition-colors"
            >
              &times;
            </button>
          </div>

          {/* Free splits count */}
          <div className="bg-background-secondary/30 rounded-lg p-3 text-sm">
            <span className="text-foreground-muted">Unassigned splits: </span>
            <span className="font-bold text-foreground">{freeSplitsCount}</span>
          </div>

          {/* Method selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground-secondary">Assignment Method</label>
            {METHODS.map(method => (
              <button
                key={method.value}
                onClick={() => setSelectedMethod(method.value)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  selectedMethod === method.value
                    ? 'border-emerald-500/50 bg-emerald-500/5'
                    : 'border-border/50 hover:border-border'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full border-2 ${
                    selectedMethod === method.value
                      ? 'border-emerald-500 bg-emerald-500'
                      : 'border-foreground-muted'
                  }`} />
                  <span className="text-sm font-medium text-foreground">{method.label}</span>
                </div>
                <p className="text-xs text-foreground-muted mt-1 ml-5">{method.description}</p>
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            {/* Clear All button */}
            <div>
              {confirmClear ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-rose-400">Are you sure?</span>
                  <button
                    onClick={handleClear}
                    disabled={loading}
                    className="px-3 py-1.5 text-xs bg-rose-500/20 text-rose-400 rounded hover:bg-rose-500/30 disabled:opacity-50 transition-colors"
                  >
                    Yes, Clear All
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    className="px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 rounded transition-colors"
                >
                  Clear All Assignments
                </button>
              )}
            </div>

            {/* Assign button */}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAssign}
                disabled={loading || freeSplitsCount === 0}
                className="px-4 py-2 text-sm bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 disabled:opacity-50 transition-colors font-medium"
              >
                {loading ? 'Assigning...' : `Assign ${freeSplitsCount} Splits`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/AutoAssignDialog.tsx
git commit -m "feat: add AutoAssignDialog component with method selection and clear-all"
```

---

## Task 8: Extend LotViewer with Unlinked Splits Section

**Files:**
- Modify: `src/components/ledger/LotViewer.tsx`

- [ ] **Step 1: Add unlinked splits section to LotViewer**

In `src/components/ledger/LotViewer.tsx`, update the component to:

1. Fetch lots with `?includeFreeSplits=true`
2. Store free splits state
3. Add unlinked splits count badge + quick-assign button below the lot list

Update `fetchLots` to use `includeFreeSplits`:

```typescript
const res = await fetch(`/api/accounts/${accountGuid}/lots?includeFreeSplits=true`);
```

Add state:

```typescript
const [freeSplits, setFreeSplits] = useState<LotSplit[]>([]);
const [showAutoAssign, setShowAutoAssign] = useState(false);
```

In the fetch callback, after `setLots(lotList)`:

```typescript
setFreeSplits(data.freeSplits || []);
```

Add the unlinked splits section between the closed-lots toggle and the lot cards:

```tsx
{/* Unlinked splits */}
{freeSplits.length > 0 && (
  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 flex items-center justify-between">
    <div>
      <span className="text-xs font-medium text-amber-400">
        {freeSplits.length} unlinked split{freeSplits.length !== 1 ? 's' : ''}
      </span>
    </div>
    <button
      onClick={() => setShowAutoAssign(true)}
      className="text-xs px-2 py-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors"
    >
      Auto-Assign
    </button>
  </div>
)}
```

Import and render AutoAssignDialog at the bottom of the component (before closing `</div>`):

```tsx
import AutoAssignDialog from './AutoAssignDialog';

// At the bottom of the return, before the final </div>:
{showAutoAssign && (
  <AutoAssignDialog
    accountGuid={accountGuid}
    freeSplitsCount={freeSplits.length}
    currentMethod={null}
    isOpen={showAutoAssign}
    onClose={() => setShowAutoAssign(false)}
    onAssign={async (method) => {
      await fetch(`/api/accounts/${accountGuid}/lots/auto-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      fetchLots(); // Refresh
    }}
    onClearAll={async () => {
      await fetch(`/api/accounts/${accountGuid}/lots/clear-assign`, {
        method: 'POST',
      });
      fetchLots(); // Refresh
    }}
  />
)}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/LotViewer.tsx
git commit -m "feat: add unlinked splits section with auto-assign integration in LotViewer"
```

---

## Task 9: Wire LotAssignmentPopover into AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

- [ ] **Step 1: Add lot assignment popover to investment split rows**

In `src/components/AccountLedger.tsx`:

1. Import `LotAssignmentPopover`:
```typescript
import LotAssignmentPopover from './ledger/LotAssignmentPopover';
```

2. Add a handler function for split lot assignment:
```typescript
const handleSplitLotAssign = async (splitGuid: string, lotGuid: string | null) => {
  await fetch(`/api/splits/${splitGuid}/lot`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lot_guid: lotGuid }),
  });
  refreshLotMap();
};

const refreshLotMap = () => {
  fetch(`/api/accounts/${accountGuid}/lots`)
    .then(r => r.json())
    .then(data => {
      const lots = Array.isArray(data) ? data : data.lots || [];
      const map = new Map();
      lots.forEach((lot: any, i: number) => {
        map.set(lot.guid, {
          index: i,
          isClosed: lot.isClosed,
          title: lot.title,
          totalShares: lot.totalShares,
          totalCost: lot.totalCost,
          unrealizedGain: lot.unrealizedGain,
          holdingPeriod: lot.holdingPeriod,
        });
      });
      setLotMap(map);
    });
};

const handleSplitCreateAndAssign = async (splitGuid: string, title: string) => {
  await fetch(`/api/splits/${splitGuid}/lot`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lot_guid: 'new', title }),
  });
  refreshLotMap(); // Only refresh, do NOT re-assign
};
```

3. Next to each `LotBadge` in the investment row rendering, add a `LotAssignmentPopover`. Find the locations where `LotBadge` is rendered (around lines 1659 and 2170) and add the popover adjacent to the badge:

```tsx
<LotAssignmentPopover
  splitGuid={mLotSplit?.guid || tx.splits?.find(s => s.account_guid === accountGuid)?.guid || ''}
  currentLotGuid={mLotSplit?.lot_guid || null}
  accountGuid={accountGuid}
  lots={Array.from(lotMap.entries()).map(([guid, info]) => ({
    guid,
    title: info.title,
    totalShares: info.totalShares,
    isClosed: info.isClosed,
  }))}
  currencyMnemonic={accountCurrency}
  onAssign={handleSplitLotAssign}
  onCreateAndAssign={handleSplitCreateAndAssign}
/>
```

**Implementation note:** The exact JSX placement depends on the current structure at lines ~1655-1680 and ~2155-2185. Place the popover right after the `LotBadge` component in both the mobile and desktop rendering paths. If a split has no lot badge (unassigned), still show the popover trigger.

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: wire LotAssignmentPopover into AccountLedger investment rows"
```

---

## Task 10: Wash Sale Detection Service

**Files:**
- Modify: `src/lib/lot-assignment.ts`

- [ ] **Step 1: Add wash sale detection function**

Add to the bottom of `src/lib/lot-assignment.ts`:

```typescript
export interface WashSaleResult {
  splitGuid: string;
  sellDate: string;
  sellAccountGuid: string;
  sellAccountName: string;
  ticker: string;
  shares: number;
  loss: number;
  washBuyDate: string;
  washBuyAccountGuid: string;
  washBuyAccountName: string;
  daysApart: number;
}

/**
 * Detect wash sales across all STOCK/MUTUAL accounts in the book.
 *
 * IRS wash sale rule: A loss is disallowed if you buy substantially identical
 * securities within 30 days before or after the sale.
 *
 * This checks CROSS-ACCOUNT: if you sell AAPL at a loss in one account
 * and buy AAPL in another account within the window, it's a wash sale.
 */
export async function detectWashSales(
  bookAccountGuids: string[]
): Promise<WashSaleResult[]> {
  // Get all investment accounts (STOCK/MUTUAL)
  const investmentAccounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: ['STOCK', 'MUTUAL'] },
    },
    select: {
      guid: true,
      name: true,
      commodity_guid: true,
      commodity: { select: { mnemonic: true } },
    },
  });

  if (investmentAccounts.length === 0) return [];

  // Group accounts by commodity (ticker)
  const accountsByCommodity = new Map<string, typeof investmentAccounts>();
  for (const acct of investmentAccounts) {
    if (!acct.commodity_guid) continue;
    const existing = accountsByCommodity.get(acct.commodity_guid) || [];
    existing.push(acct);
    accountsByCommodity.set(acct.commodity_guid, existing);
  }

  const washSales: WashSaleResult[] = [];
  const WASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  for (const [commodityGuid, accounts] of accountsByCommodity) {
    const accountGuids = accounts.map(a => a.guid);
    const ticker = accounts[0].commodity?.mnemonic || 'Unknown';

    // Get all splits across these accounts
    const allSplits = await prisma.splits.findMany({
      where: { account_guid: { in: accountGuids } },
      include: {
        transaction: { select: { post_date: true } },
      },
      orderBy: { transaction: { post_date: 'asc' } },
    });

    // Separate sells (negative quantity) and buys (positive quantity)
    const sells: Array<typeof allSplits[0] & { realizedLoss: number }> = [];
    const buys = allSplits.filter(s =>
      toDecimal(s.quantity_num, s.quantity_denom) > 0
    );

    // For each sell, determine if it was at a loss by checking lot data.
    // If the sell is assigned to a lot, compute realized gain from the lot.
    // If not assigned, use a simple heuristic: compare value/qty (proceeds per share)
    // against the average cost per share of buys in the same account.
    for (const s of allSplits) {
      const qty = toDecimal(s.quantity_num, s.quantity_denom);
      if (qty >= 0) continue; // Not a sell

      const val = toDecimal(s.value_num, s.value_denom);
      // In GnuCash, the value on an investment split represents the cost basis change.
      // For a sell: positive value = proceeds > 0 (profitable), negative value = loss.
      // But this depends on GnuCash conventions — the *other* split in the transaction
      // holds the actual cash proceeds. For lot-based detection, use lot data.

      if (s.lot_guid) {
        // Lot-based: check if the lot has a realized loss
        const lot = await prisma.lots.findUnique({
          where: { guid: s.lot_guid },
          include: { splits: { include: { transaction: { select: { post_date: true } } } } },
        });
        if (lot) {
          const lotSplits = lot.splits;
          const totalValue = lotSplits.reduce(
            (sum, ls) => sum + toDecimal(ls.value_num, ls.value_denom), 0
          );
          const totalQty = lotSplits.reduce(
            (sum, ls) => sum + toDecimal(ls.quantity_num, ls.quantity_denom), 0
          );
          // If lot is closed (qty ~0) and total value is negative, it's a loss
          if (Math.abs(totalQty) < 0.0001 && totalValue < 0) {
            sells.push({ ...s, realizedLoss: totalValue });
            continue;
          }
        }
      }

      // Fallback: if value is negative on the investment split, treat as loss
      // (GnuCash records sell splits with value = -(proceeds), so negative value
      // means the account's cost basis decreased — this is always true for sells.
      // We need to compare against cost. Simple heuristic: check if absolute value
      // per share is less than average buy price per share.)
      const accountBuys = buys.filter(b => b.account_guid === s.account_guid);
      if (accountBuys.length > 0) {
        const totalBuyQty = accountBuys.reduce(
          (sum, b) => sum + toDecimal(b.quantity_num, b.quantity_denom), 0
        );
        const totalBuyCost = accountBuys.reduce(
          (sum, b) => sum + Math.abs(toDecimal(b.value_num, b.value_denom)), 0
        );
        const avgCostPerShare = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
        const sellProceedsPerShare = Math.abs(val / qty);
        if (sellProceedsPerShare < avgCostPerShare) {
          const loss = (sellProceedsPerShare - avgCostPerShare) * Math.abs(qty);
          sells.push({ ...s, realizedLoss: loss });
        }
      }
    }

    for (const sell of sells) {
      const sellDate = sell.transaction?.post_date;
      if (!sellDate) continue;
      const sellMs = sellDate.getTime();

      // Check if any buy of same commodity within 30-day window
      for (const buy of buys) {
        const buyDate = buy.transaction?.post_date;
        if (!buyDate) continue;
        const buyMs = buyDate.getTime();
        const diff = Math.abs(buyMs - sellMs);

        if (diff <= WASH_WINDOW_MS && buy.guid !== sell.guid) {
          const sellAccount = accounts.find(a => a.guid === sell.account_guid);
          const buyAccount = accounts.find(a => a.guid === buy.account_guid);
          const daysApart = Math.round(diff / (24 * 60 * 60 * 1000));

          washSales.push({
            splitGuid: sell.guid,
            sellDate: sellDate.toISOString(),
            sellAccountGuid: sell.account_guid,
            sellAccountName: sellAccount?.name || '',
            ticker,
            shares: Math.abs(toDecimal(sell.quantity_num, sell.quantity_denom)),
            loss: sell.realizedLoss,
            washBuyDate: buyDate.toISOString(),
            washBuyAccountGuid: buy.account_guid,
            washBuyAccountName: buyAccount?.name || '',
            daysApart,
          });
          break; // One wash match per sell is enough to flag it
        }
      }
    }
  }

  return washSales;
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/lot-assignment.ts
git commit -m "feat: add cross-account wash sale detection"
```

---

## Task 11: Tax Harvesting Report API

**Files:**
- Create: `src/app/api/reports/tax-harvesting/route.ts`

- [ ] **Step 1: Create tax harvesting API endpoint**

Create `src/app/api/reports/tax-harvesting/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getAccountLots } from '@/lib/lots';
import { detectWashSales, WashSaleResult } from '@/lib/lot-assignment';

interface HarvestCandidate {
  accountGuid: string;
  accountName: string;
  ticker: string;
  lotGuid: string;
  lotTitle: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  unrealizedLoss: number;
  holdingPeriod: 'short_term' | 'long_term' | null;
  projectedSavings: {
    shortTerm: number;
    longTerm: number;
  };
}

interface TaxHarvestingData {
  candidates: HarvestCandidate[];
  washSales: WashSaleResult[];
  taxRates: { shortTerm: number; longTerm: number };
  summary: {
    totalHarvestableLoss: number;
    totalProjectedSavingsShortTerm: number;
    totalProjectedSavingsLongTerm: number;
    washSaleCount: number;
    candidateCount: number;
  };
  generatedAt: string;
}

export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { searchParams } = new URL(request.url);
    const shortTermRate = parseFloat(searchParams.get('shortTermRate') || '0.37');
    const longTermRate = parseFloat(searchParams.get('longTermRate') || '0.20');

    const bookAccountGuids = await getBookAccountGuids();

    // Get all STOCK/MUTUAL accounts
    const investmentAccounts = await prisma.accounts.findMany({
      where: {
        guid: { in: bookAccountGuids },
        account_type: { in: ['STOCK', 'MUTUAL'] },
      },
      select: {
        guid: true,
        name: true,
        commodity_guid: true,
        commodity: { select: { mnemonic: true } },
      },
    });

    const candidates: HarvestCandidate[] = [];

    for (const account of investmentAccounts) {
      const lots = await getAccountLots(account.guid);

      for (const lot of lots) {
        // Only open lots with unrealized losses are harvest candidates
        if (lot.isClosed || lot.unrealizedGain === null || lot.unrealizedGain >= 0) continue;
        if (Math.abs(lot.totalShares) < 0.0001) continue;

        const marketValue = lot.currentPrice !== null
          ? lot.currentPrice * lot.totalShares
          : 0;
        const unrealizedLoss = lot.unrealizedGain; // negative

        candidates.push({
          accountGuid: account.guid,
          accountName: account.name,
          ticker: account.commodity?.mnemonic || 'Unknown',
          lotGuid: lot.guid,
          lotTitle: lot.title,
          shares: lot.totalShares,
          costBasis: lot.totalCost,
          marketValue,
          unrealizedLoss,
          holdingPeriod: lot.holdingPeriod,
          projectedSavings: {
            shortTerm: Math.abs(unrealizedLoss) * shortTermRate,
            longTerm: Math.abs(unrealizedLoss) * longTermRate,
          },
        });
      }
    }

    // Sort by largest loss first
    candidates.sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);

    // Detect wash sales
    const washSales = await detectWashSales(bookAccountGuids);

    const totalHarvestableLoss = candidates.reduce((sum, c) => sum + c.unrealizedLoss, 0);

    const data: TaxHarvestingData = {
      candidates,
      washSales,
      taxRates: { shortTerm: shortTermRate, longTerm: longTermRate },
      summary: {
        totalHarvestableLoss,
        totalProjectedSavingsShortTerm: Math.abs(totalHarvestableLoss) * shortTermRate,
        totalProjectedSavingsLongTerm: Math.abs(totalHarvestableLoss) * longTermRate,
        washSaleCount: washSales.length,
        candidateCount: candidates.length,
      },
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error generating tax harvesting report:', error);
    return NextResponse.json(
      { error: 'Failed to generate tax harvesting report' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/reports/tax-harvesting/route.ts
git commit -m "feat: add tax harvesting report API with harvest candidates and wash sales"
```

---

## Task 12: Tax Harvesting Report Page

**Files:**
- Create: `src/app/(main)/reports/tax_harvesting/page.tsx`
- Modify: `src/lib/reports/types.ts`

- [ ] **Step 1: Add TAX_HARVESTING to ReportType enum**

In `src/lib/reports/types.ts`, add to the `ReportType` enum:

```typescript
TAX_HARVESTING = 'tax_harvesting',
```

- [ ] **Step 2: Create the tax harvesting report page**

Create `src/app/(main)/reports/tax_harvesting/page.tsx`.

**Note:** The hardcoded `'USD'` in `formatCurrency` calls below should be replaced with a dynamic currency from the API response. The tax harvesting API should be extended to include the book's default currency (from the root account's commodity), and the page should use that. For the initial implementation, 'USD' is acceptable and can be refined in a follow-up.

Content:

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import Link from 'next/link';

interface HarvestCandidate {
  accountGuid: string;
  accountName: string;
  ticker: string;
  lotGuid: string;
  lotTitle: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  unrealizedLoss: number;
  holdingPeriod: 'short_term' | 'long_term' | null;
  projectedSavings: { shortTerm: number; longTerm: number };
}

interface WashSale {
  splitGuid: string;
  sellDate: string;
  sellAccountName: string;
  ticker: string;
  shares: number;
  loss: number;
  washBuyDate: string;
  washBuyAccountName: string;
  daysApart: number;
}

interface TaxHarvestingData {
  candidates: HarvestCandidate[];
  washSales: WashSale[];
  taxRates: { shortTerm: number; longTerm: number };
  summary: {
    totalHarvestableLoss: number;
    totalProjectedSavingsShortTerm: number;
    totalProjectedSavingsLongTerm: number;
    washSaleCount: number;
    candidateCount: number;
  };
  generatedAt: string;
}

export default function TaxHarvestingPage() {
  const [data, setData] = useState<TaxHarvestingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shortTermRate, setShortTermRate] = useState(37);
  const [longTermRate, setLongTermRate] = useState(20);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        shortTermRate: (shortTermRate / 100).toString(),
        longTermRate: (longTermRate / 100).toString(),
      });
      const res = await fetch(`/api/reports/tax-harvesting?${params}`);
      if (!res.ok) throw new Error('Failed to fetch report');
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [shortTermRate, longTermRate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tax-Loss Harvesting Dashboard</h1>
          <p className="text-sm text-foreground-muted mt-1">
            Identify lots with unrealized losses and potential wash sale conflicts.
          </p>
        </div>
      </div>

      {/* Tax Rate Configuration */}
      <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl p-4">
        <h3 className="text-sm font-medium text-foreground-secondary mb-3">Tax Rates</h3>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">Short-Term Rate:</span>
            <input
              type="number"
              value={shortTermRate}
              onChange={e => setShortTermRate(Number(e.target.value))}
              min={0}
              max={100}
              className="w-16 px-2 py-1 text-sm bg-input-bg border border-border rounded text-foreground text-right"
            />
            <span className="text-xs text-foreground-muted">%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">Long-Term Rate:</span>
            <input
              type="number"
              value={longTermRate}
              onChange={e => setLongTermRate(Number(e.target.value))}
              min={0}
              max={100}
              className="w-16 px-2 py-1 text-sm bg-input-bg border border-border rounded text-foreground text-right"
            />
            <span className="text-xs text-foreground-muted">%</span>
          </label>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
            <span className="text-foreground-secondary">Loading...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-rose-400">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Harvestable Loss</div>
              <div className="text-lg font-bold font-mono text-rose-400">
                {formatCurrency(data.summary.totalHarvestableLoss, 'USD')}
              </div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Projected Savings (ST)</div>
              <div className="text-lg font-bold font-mono text-emerald-400">
                {formatCurrency(data.summary.totalProjectedSavingsShortTerm, 'USD')}
              </div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Candidates</div>
              <div className="text-lg font-bold text-foreground">{data.summary.candidateCount}</div>
            </div>
            <div className="bg-background-secondary/30 border border-border rounded-xl p-4">
              <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Wash Sales</div>
              <div className={`text-lg font-bold ${data.summary.washSaleCount > 0 ? 'text-amber-400' : 'text-foreground'}`}>
                {data.summary.washSaleCount}
              </div>
            </div>
          </div>

          {/* Harvest Candidates Table */}
          <div className="bg-background-secondary/30 backdrop-blur-xl border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Harvest Candidates
              </h3>
            </div>
            {data.candidates.length === 0 ? (
              <div className="p-8 text-center text-foreground-muted text-sm">
                No lots with unrealized losses found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                      <th className="px-4 py-3 text-left">Ticker</th>
                      <th className="px-4 py-3 text-left">Account</th>
                      <th className="px-4 py-3 text-left">Lot</th>
                      <th className="px-4 py-3 text-right">Shares</th>
                      <th className="px-4 py-3 text-right">Cost Basis</th>
                      <th className="px-4 py-3 text-right">Market Value</th>
                      <th className="px-4 py-3 text-right">Unrealized Loss</th>
                      <th className="px-4 py-3 text-center">Period</th>
                      <th className="px-4 py-3 text-right">Tax Savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map(c => (
                      <tr key={c.lotGuid} className="border-b border-border/30 hover:bg-background-secondary/20 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{c.ticker}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/accounts/${c.accountGuid}`}
                            className="text-cyan-400 hover:text-cyan-300 transition-colors"
                          >
                            {c.accountName}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-foreground-secondary">{c.lotTitle}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{c.shares.toFixed(4)}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{formatCurrency(c.costBasis, 'USD')}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{formatCurrency(c.marketValue, 'USD')}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-400">{formatCurrency(c.unrealizedLoss, 'USD')}</td>
                        <td className="px-4 py-3 text-center">
                          {c.holdingPeriod && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              c.holdingPeriod === 'long_term'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-amber-500/20 text-amber-400'
                            }`}>
                              {c.holdingPeriod === 'long_term' ? 'LT' : 'ST'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-emerald-400">
                          {formatCurrency(
                            c.holdingPeriod === 'long_term'
                              ? c.projectedSavings.longTerm
                              : c.projectedSavings.shortTerm,
                            'USD'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Wash Sales Table */}
          {data.washSales.length > 0 && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl overflow-hidden">
              <div className="p-4 border-b border-amber-500/20">
                <h3 className="text-sm font-semibold text-amber-400 uppercase tracking-wider">
                  Wash Sale Warnings
                </h3>
                <p className="text-xs text-foreground-muted mt-1">
                  These sales occurred within 30 days of a purchase of the same security (including across accounts).
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-amber-500/20">
                      <th className="px-4 py-3 text-left">Ticker</th>
                      <th className="px-4 py-3 text-left">Sell Date</th>
                      <th className="px-4 py-3 text-left">Sell Account</th>
                      <th className="px-4 py-3 text-right">Shares</th>
                      <th className="px-4 py-3 text-right">Loss</th>
                      <th className="px-4 py-3 text-left">Wash Buy Date</th>
                      <th className="px-4 py-3 text-left">Buy Account</th>
                      <th className="px-4 py-3 text-center">Days Apart</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.washSales.map((ws, i) => (
                      <tr key={`${ws.splitGuid}-${i}`} className="border-b border-amber-500/10 hover:bg-amber-500/5 transition-colors">
                        <td className="px-4 py-3 font-medium text-foreground">{ws.ticker}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{new Date(ws.sellDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{ws.sellAccountName}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{ws.shares.toFixed(4)}</td>
                        <td className="px-4 py-3 text-right font-mono text-rose-400">{formatCurrency(ws.loss, 'USD')}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{new Date(ws.washBuyDate).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-foreground-secondary">{ws.washBuyAccountName}</td>
                        <td className="px-4 py-3 text-center font-mono text-amber-400">{ws.daysApart}d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/reports/types.ts src/app/\(main\)/reports/tax_harvesting/page.tsx
git commit -m "feat: add tax-loss harvesting dashboard page with harvest candidates and wash sale warnings"
```

---

## Task 13: Add Tax Harvesting to Navigation

**Files:**
- Modify: `src/lib/reports/types.ts:17` (ReportType enum) and `~line 256` (REPORTS array)
- The reports index page at `src/app/(main)/reports/page.tsx` auto-discovers reports via `getReportsByCategory()` — no change needed there.

- [ ] **Step 1: Add to REPORTS config array**

In `src/lib/reports/types.ts`, find the `REPORTS` array (around line 230+). After the `INVESTMENT_LOTS` entry (around line 256), add:

```typescript
{
  type: ReportType.TAX_HARVESTING,
  name: 'Tax-Loss Harvesting',
  description: 'Identify tax-loss harvesting opportunities and wash sale risks',
  icon: 'scissors',
  category: 'investment',
},
```

The reports index page at `src/app/(main)/reports/page.tsx` uses `getReportsByCategory()` which reads from the `REPORTS` array — the new report will automatically appear under the "Investment Reports" category.

- [ ] **Step 2: Verify the page is accessible**

Run: `npx next build 2>&1 | head -30`
Expected: Build succeeds. Navigate to `/reports/tax_harvesting` in dev mode to verify it appears in the reports index and the page loads.

- [ ] **Step 3: Commit**

```bash
git add src/lib/reports/types.ts
git commit -m "feat: add tax-loss harvesting to report navigation"
```

---

## Task 14: Final Integration Verification

- [ ] **Step 1: Full build check**

Run: `npx next build`
Expected: Build succeeds with zero errors.

- [ ] **Step 2: Verify all new API routes exist**

Run these curl commands against dev server:
- `GET /api/accounts/{guid}/lots?includeFreeSplits=true` — should return lots + free splits
- `POST /api/accounts/{guid}/lots` with `{ "title": "Test Lot" }` — should create lot
- `POST /api/accounts/{guid}/lots/auto-assign` with `{ "method": "fifo" }` — should run auto-assign
- `POST /api/accounts/{guid}/lots/clear-assign` — should clear assignments
- `PATCH /api/splits/{guid}/lot` with `{ "lot_guid": null }` — should unassign
- `GET /api/reports/tax-harvesting` — should return harvest data

- [ ] **Step 3: Verify UI flows**

1. Open an investment account ledger
2. Verify LotAssignmentPopover appears next to lot badges
3. Open LotViewer tab and verify unlinked splits count shows
4. Click Auto-Assign button and verify the dialog opens
5. Navigate to `/reports/tax_harvesting` and verify dashboard loads

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for lot assignment and tax harvesting"
```
