# Investment Ledger Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standard debit/credit ledger with investment-specific columns (Date, Description, Transfer, Shares, Price, Buy, Sell, Share Balance, Cost Basis) when viewing STOCK/MUTUAL accounts.

**Architecture:** Extend the existing `AccountLedger` component with investment column awareness. Add `commodityNamespace` prop for detection, define `getInvestmentColumns()` in `columns.tsx`, add `transformToInvestmentRow()` for client-side data transformation, create `InvestmentEditRow` for the auto-calc edit form, and add server-side `starting_share_balance` / `starting_cost_basis` to the transactions API.

**Tech Stack:** Next.js 16, React 19, TypeScript, TanStack Table, Prisma ORM, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-10-investment-ledger-design.md`

---

## Chunk 1: Data Layer

### Task 1: Add investment balance seed values to the transactions API

The existing API at `src/app/api/accounts/[guid]/transactions/route.ts` calculates `startingBalance` for monetary running balance. We need analogous values for share balance and cost basis when the account is an investment account.

**Files:**
- Modify: `src/app/api/accounts/[guid]/transactions/route.ts`

- [ ] **Step 1: Move account fetch earlier and detect investment account**

The account fetch currently happens at line 176 (after the `startingBalance` block). Move it to *before* the `startingBalance` computation block (before line 64) so `isInvestmentAccount` is in scope for the investment seed calculation:

```typescript
// Move this block from lines 176-181 to before line 64:
const account = await prisma.accounts.findUnique({
    where: { guid: accountGuid },
    include: { commodity: true },
});
const accountMnemonic = account?.commodity?.mnemonic || '';
const isInvestmentAccount = account?.commodity?.namespace !== undefined
    && account.commodity.namespace !== 'CURRENCY';
```

Remove the duplicate account fetch that was at lines 176-181.

- [ ] **Step 2: Calculate starting_share_balance and starting_cost_basis**

Add a new block inside `if (!unreviewedOnly)`, right after the existing `startingBalance` calculation (after the closing brace of the `if (offset > 0)` block around line 125):

```typescript
let startingShareBalance = 0;
let startingCostBasis = 0;

if (isInvestmentAccount) {
    // Fetch ALL splits for this account in chronological order (within date range)
    const allInvestmentSplits = await prisma.$queryRaw<{
        quantity_num: bigint;
        quantity_denom: bigint;
        value_num: bigint;
        value_denom: bigint;
    }[]>`
        SELECT s.quantity_num, s.quantity_denom, s.value_num, s.value_denom
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${accountGuid}
        ${endDate ? Prisma.sql`AND t.post_date <= ${new Date(endDate)}` : Prisma.empty}
        ${startDate ? Prisma.sql`AND t.post_date >= ${new Date(startDate)}` : Prisma.empty}
        ORDER BY t.post_date ASC, t.enter_date ASC
    `;

    // Process ALL splits to compute total share balance and cost basis
    let totalShares = 0;
    let totalCostBasis = 0;
    for (const split of allInvestmentSplits) {
        const shares = Number(split.quantity_num) / Number(split.quantity_denom);
        const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

        if (shares > 0) {
            totalShares += shares;
            totalCostBasis += value;
        } else if (shares < 0) {
            const soldShares = Math.abs(shares);
            if (totalShares > 0) {
                const avgCost = totalCostBasis / totalShares;
                totalCostBasis -= avgCost * soldShares;
            }
            totalShares += shares;
        }
    }

    // For page 0: starting values = totals (newest row at top gets full balance)
    startingShareBalance = totalShares;
    startingCostBasis = totalCostBasis;

    // For page N>0: subtract the newer-page transactions' contributions
    // (same pattern as existing monetary startingBalance)
    if (offset > 0) {
        // Re-process from scratch, stopping at (total - offset) transactions
        // This gives us the state just before the first transaction on this page
        const totalCount = allInvestmentSplits.length;
        const pageStartIndex = totalCount - offset; // chronological index where this page starts

        let runShares = 0;
        let runCostBasis = 0;
        // Process only up to the page boundary (chronological order)
        for (let i = 0; i < Math.max(0, pageStartIndex); i++) {
            const split = allInvestmentSplits[i];
            const shares = Number(split.quantity_num) / Number(split.quantity_denom);
            const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

            if (shares > 0) {
                runShares += shares;
                runCostBasis += value;
            } else if (shares < 0) {
                const soldShares = Math.abs(shares);
                if (runShares > 0) {
                    const avgCost = runCostBasis / runShares;
                    runCostBasis -= avgCost * soldShares;
                }
                runShares += shares;
            }
        }
        // Wait — this gives us the state BEFORE the page, but the page displays
        // newest-first. The "starting" balance for the page is the state AFTER
        // all newer transactions (i.e., after processing the full dataset minus
        // the transactions on this page and older).
        // Actually: the first row on the page (newest on this page) should show
        // the balance after itself, which means the seed should be the state
        // after processing all newer transactions plus this page's transactions.
        // This is exactly `totalShares` minus the older pages' contributions.
        // Simplest: startingShareBalance = totalShares, startingCostBasis = totalCostBasis
        // is correct for page 0. For page N, we need the state after all
        // transactions that appear on pages 0..N-1 (the `offset` newest ones).
        //
        // Correct approach: process the `offset` newest transactions forward:
        const newerStartIndex = totalCount - offset; // start of newer transactions in chrono order
        let newerShares = 0;
        let newerCostBasis = 0;

        // Process the newer transactions in chronological order to get their net effect
        // But cost basis requires knowing the full context...
        // Actually the simplest correct approach: compute running totals at
        // the exact boundary point.
    }
}
```

**Wait — the pagination + average cost basis is more subtle than it looks.** Let me use a cleaner approach. Since we already have ALL splits in chronological order, we can compute the running totals at every point and just index into the right position:

```typescript
let startingShareBalance = 0;
let startingCostBasis = 0;

if (isInvestmentAccount) {
    const allInvestmentSplits = await prisma.$queryRaw<{
        quantity_num: bigint;
        quantity_denom: bigint;
        value_num: bigint;
        value_denom: bigint;
    }[]>`
        SELECT s.quantity_num, s.quantity_denom, s.value_num, s.value_denom
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${accountGuid}
        ${endDate ? Prisma.sql`AND t.post_date <= ${new Date(endDate)}` : Prisma.empty}
        ${startDate ? Prisma.sql`AND t.post_date >= ${new Date(startDate)}` : Prisma.empty}
        ORDER BY t.post_date ASC, t.enter_date ASC
    `;

    // Process ALL splits forward to build running totals
    let runShares = 0;
    let runCostBasis = 0;
    // Array of running totals at each chronological position
    const runningTotals: { shares: number; costBasis: number }[] = [];

    for (const split of allInvestmentSplits) {
        const shares = Number(split.quantity_num) / Number(split.quantity_denom);
        const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

        if (shares > 0) {
            runShares += shares;
            runCostBasis += value;
        } else if (shares < 0) {
            const soldShares = Math.abs(shares);
            if (runShares > 0) {
                const avgCost = runCostBasis / runShares;
                runCostBasis -= avgCost * soldShares;
            }
            runShares += shares;
        }
        runningTotals.push({ shares: runShares, costBasis: runCostBasis });
    }

    const totalCount = allInvestmentSplits.length;

    if (totalCount === 0) {
        startingShareBalance = 0;
        startingCostBasis = 0;
    } else if (offset === 0) {
        // Page 0: seed = final totals (newest row at top shows full balance)
        startingShareBalance = runShares;
        startingCostBasis = runCostBasis;
    } else {
        // Page N: seed = totals after all transactions EXCEPT the oldest `totalCount - offset`
        // The "starting" value for the page is the running total at position (totalCount - offset - 1)
        // because the page shows transactions from position (totalCount - offset) to (totalCount - offset - limit)
        // in reverse chronological order. The top row of this page should show
        // the balance after itself, which is the running total at (totalCount - offset).
        // But we index: the `offset` newest transactions are at indices [totalCount-offset..totalCount-1].
        // The seed for this page = running total at index (totalCount - offset - 1), which is
        // the state just before the first transaction on previous pages started.
        // Wait, display is newest-first. Page 0 shows indices [totalCount-1..totalCount-100].
        // Page 1 (offset=100) shows indices [totalCount-101..totalCount-200].
        // The top row of page 1 (index totalCount-101) should show the balance
        // after processing all transactions up to and including itself.
        // Seed for page 1 = runningTotals[totalCount - offset - 1] = runningTotals[totalCount - 101]
        const seedIndex = totalCount - offset - 1;
        if (seedIndex >= 0 && seedIndex < runningTotals.length) {
            startingShareBalance = runningTotals[seedIndex].shares;
            startingCostBasis = runningTotals[seedIndex].costBasis;
        } else {
            startingShareBalance = 0;
            startingCostBasis = 0;
        }
    }
}
```

**This is still getting complex and error-prone with index math.** Let me take the simplest correct approach that avoids index gymnastics:

**Final approach for Step 2:** Compute running totals for the full dataset on the server, then return the seed values for the current page. The "seed" for any page = the running total at the chronological position of the page's newest transaction.

Actually, the simplest approach mirrors what the existing code does for monetary balance: compute the TOTAL, then subtract the contributions of the `offset` newest transactions. For monetary balance this is easy (just sum quantities). For cost basis, subtraction is hard because average cost is path-dependent.

**Truly simplest correct approach:** Return `runningTotals` for each transaction from the server, pre-computed. Then the client doesn't need to do any running balance math at all — each transaction row already has its share balance and cost basis attached.

```typescript
// In the response building section (the transactions.map at line 185):
// For investment accounts, compute per-row share balance and cost basis

let investmentRunningTotals: Map<string, { shareBalance: number; costBasis: number }> | null = null;

if (isInvestmentAccount) {
    // allInvestmentSplits is already fetched above in chronological order
    // Build a map from tx_guid to running totals
    // But we need tx_guids... let's enhance the query:
    const allSplitsWithTx = await prisma.$queryRaw<{
        tx_guid: string;
        quantity_num: bigint;
        quantity_denom: bigint;
        value_num: bigint;
        value_denom: bigint;
    }[]>`
        SELECT s.tx_guid, s.quantity_num, s.quantity_denom, s.value_num, s.value_denom
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${accountGuid}
        ${endDate ? Prisma.sql`AND t.post_date <= ${new Date(endDate)}` : Prisma.empty}
        ${startDate ? Prisma.sql`AND t.post_date >= ${new Date(startDate)}` : Prisma.empty}
        ORDER BY t.post_date ASC, t.enter_date ASC
    `;

    let runShares = 0;
    let runCostBasis = 0;
    investmentRunningTotals = new Map();

    for (const split of allSplitsWithTx) {
        const shares = Number(split.quantity_num) / Number(split.quantity_denom);
        const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

        if (shares > 0) {
            runShares += shares;
            runCostBasis += value;
        } else if (shares < 0) {
            const soldShares = Math.abs(shares);
            if (runShares > 0) {
                const avgCost = runCostBasis / runShares;
                runCostBasis -= avgCost * soldShares;
            }
            runShares += shares;
        }
        investmentRunningTotals.set(split.tx_guid, {
            shareBalance: runShares,
            costBasis: runCostBasis,
        });
    }
}
```

Then in the response map (line 185), add the investment totals to each row:

```typescript
const row = {
    // ...existing fields...
    // Investment-specific running totals (pre-computed server-side)
    ...(investmentRunningTotals ? {
        share_balance: investmentRunningTotals.get(tx.guid)?.shareBalance.toString() ?? '0',
        cost_basis: investmentRunningTotals.get(tx.guid)?.costBasis.toString() ?? '0',
    } : {}),
};
```

This eliminates ALL client-side running balance math for investments. No seed values needed. No pagination edge cases. Each transaction row carries its own correct share balance and cost basis, computed forward in chronological order on the server.

- [ ] **Step 3: Add is_investment flag to the response**

After the result array is built, wrap the response for investment accounts:

```typescript
if (isInvestmentAccount) {
    return NextResponse.json(serializeBigInts({
        transactions: result,
        is_investment: true,
    }));
} else {
    return NextResponse.json(serializeBigInts(result));
}
```

Note: we no longer need `starting_share_balance` or `starting_cost_basis` in the response since each row carries its own values.

- [ ] **Step 4: Create a shared response parser for the client**

Create a helper used by all three fetch callsites (page `fetchData`, `AccountLedger.fetchTransactions`, and `AccountLedger.loadMore`):

In `src/components/ledger/investment-utils.ts` (created in Task 2), add:

```typescript
export interface InvestmentApiResponse {
    transactions: AccountTransaction[];
    is_investment: true;
}

export function parseTransactionsResponse(data: unknown): AccountTransaction[] {
    if (data && typeof data === 'object' && 'is_investment' in data) {
        return (data as InvestmentApiResponse).transactions;
    }
    return data as AccountTransaction[];
}
```

- [ ] **Step 5: Update ALL client-side fetch callsites**

Three places parse the transactions API response:

1. **`src/app/(main)/accounts/[guid]/page.tsx`** line 68 — `fetchData`:
```typescript
import { parseTransactionsResponse } from '@/components/ledger/investment-utils';
// ...
const txData = await txRes.json();
setTransactions(parseTransactionsResponse(txData));
```

2. **`src/components/AccountLedger.tsx`** line 192 — `fetchTransactions`:
```typescript
import { parseTransactionsResponse } from './ledger/investment-utils';
// ...
const data = await res.json();
setTransactions(parseTransactionsResponse(data));
```

3. **`src/components/AccountLedger.tsx`** — infinite scroll `loadMore` (inside the IntersectionObserver callback):
```typescript
const data = await res.json();
const newTransactions = parseTransactionsResponse(data);
```

- [ ] **Step 6: Verify the build compiles**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/accounts/[guid]/transactions/route.ts src/app/(main)/accounts/[guid]/page.tsx src/components/AccountLedger.tsx src/components/ledger/investment-utils.ts
git commit -m "feat: add server-side investment running totals to transactions API"
```

---

### Task 2: Add investment data transformation utility

Create the client-side transformation that converts raw `AccountTransaction` data into investment-specific display data. Running balances are now pre-computed server-side, so this is purely for extracting shares/price/buy/sell from splits.

**Files:**
- Create: `src/components/ledger/investment-utils.ts`

- [ ] **Step 1: Define the InvestmentRowData interface and transformation function**

```typescript
import { AccountTransaction } from '../AccountLedger';

export interface InvestmentRowData {
    guid: string;
    post_date: string | Date;
    description: string;
    transferAccount: string;
    transferAccountGuid: string;
    shares: number | null;       // null for non-share transactions (cash dividends)
    price: number | null;        // null when shares is 0
    buyAmount: number | null;    // positive number or null
    sellAmount: number | null;   // positive number or null
    shareBalance: number;        // from server-side computation
    costBasis: number;           // from server-side computation
    transactionType: 'buy' | 'sell' | 'dividend' | 'other';
}

// Response parser (also used by Task 1)
export interface InvestmentApiResponse {
    transactions: AccountTransaction[];
    is_investment: true;
}

export function parseTransactionsResponse(data: unknown): AccountTransaction[] {
    if (data && typeof data === 'object' && 'is_investment' in data) {
        return (data as InvestmentApiResponse).transactions;
    }
    return data as AccountTransaction[];
}

/**
 * Transform a raw AccountTransaction into investment-specific row data.
 * Uses pre-computed server-side values for share_balance and cost_basis.
 * Uses enriched split fields (value_decimal, quantity_decimal) instead of
 * raw num/denom to avoid floating-point precision errors.
 */
export function transformToInvestmentRow(
    tx: AccountTransaction & { share_balance?: string; cost_basis?: string },
    accountGuid: string,
): InvestmentRowData {
    const accountSplit = tx.splits?.find(s => s.account_guid === accountGuid);

    // Use pre-computed decimal fields from API (via toDecimal())
    const shares = accountSplit ? parseFloat(accountSplit.quantity_decimal) : 0;
    const totalValue = accountSplit ? parseFloat(accountSplit.value_decimal) : 0;

    const price = shares !== 0 ? Math.abs(totalValue) / Math.abs(shares) : null;
    const buyAmount = shares > 0 ? Math.abs(totalValue) : null;
    const sellAmount = shares < 0 ? Math.abs(totalValue) : null;

    let transactionType: 'buy' | 'sell' | 'dividend' | 'other';
    if (shares > 0) transactionType = 'buy';
    else if (shares < 0) transactionType = 'sell';
    else if (shares === 0 && tx.splits && tx.splits.length > 1) transactionType = 'dividend';
    else transactionType = 'other';

    // Transfer account: primary non-trading, non-self split (largest by |value|)
    const otherSplits = tx.splits?.filter(s =>
        s.account_guid !== accountGuid &&
        !s.account_fullname?.startsWith('Trading:')
    ) || [];

    let transferSplit = otherSplits[0];
    if (otherSplits.length > 1) {
        transferSplit = otherSplits.reduce((best, s) => {
            const bestVal = Math.abs(parseFloat(best.value_decimal));
            const sVal = Math.abs(parseFloat(s.value_decimal));
            return sVal > bestVal ? s : best;
        });
    }

    return {
        guid: tx.guid,
        post_date: tx.post_date,
        description: tx.description,
        transferAccount: transferSplit?.account_fullname || transferSplit?.account_name || '',
        transferAccountGuid: transferSplit?.account_guid || '',
        shares: shares !== 0 ? shares : null,
        price,
        buyAmount,
        sellAmount,
        shareBalance: parseFloat(tx.share_balance || '0'),
        costBasis: parseFloat(tx.cost_basis || '0'),
        transactionType,
    };
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/investment-utils.ts
git commit -m "feat: add investment row transformation utility"
```

---

## Chunk 2: Column Definitions & Display

### Task 3: Add investment column definitions

**Files:**
- Modify: `src/components/ledger/columns.tsx`

- [ ] **Step 1: Add getInvestmentColumns function**

Add below the existing `getColumns`:

```typescript
export function getInvestmentColumns(meta: {
    accountGuid: string;
    isReconciling: boolean;
    isEditMode: boolean;
}): ColumnDef<AccountTransaction>[] {
    return [
        ...(meta.isReconciling || meta.isEditMode ? [
            columnHelper.display({
                id: 'select',
                header: 'select',
                size: 40,
            }),
        ] : []),

        columnHelper.accessor('account_split_reconcile_state', {
            id: 'reconcile',
            header: 'R',
            size: 40,
        }),

        columnHelper.accessor('post_date', {
            id: 'date',
            header: 'Date',
        }),

        columnHelper.accessor('description', {
            id: 'description',
            header: 'Description',
        }),

        columnHelper.display({
            id: 'transfer',
            header: 'Transfer',
        }),

        columnHelper.display({
            id: 'shares',
            header: 'Shares',
        }),

        columnHelper.display({
            id: 'price',
            header: 'Price',
        }),

        columnHelper.display({
            id: 'buy',
            header: 'Buy',
        }),

        columnHelper.display({
            id: 'sell',
            header: 'Sell',
        }),

        columnHelper.display({
            id: 'shareBalance',
            header: 'Share Bal',
        }),

        columnHelper.display({
            id: 'costBasis',
            header: 'Cost Basis',
        }),

        ...(meta.isEditMode ? [
            columnHelper.display({
                id: 'actions',
                header: '',
                size: 40,
            }),
        ] : []),
    ] as ColumnDef<AccountTransaction>[];
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ledger/columns.tsx
git commit -m "feat: add investment column definitions for TanStack Table"
```

---

### Task 4: Wire investment columns into AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`
- Modify: `src/components/ledger/types.ts`

- [ ] **Step 1: Add commodityNamespace to AccountLedgerProps**

In `src/components/AccountLedger.tsx`, add to `AccountLedgerProps` (line 35):

```typescript
interface AccountLedgerProps {
    accountGuid: string;
    initialTransactions: AccountTransaction[];
    startDate?: string | null;
    endDate?: string | null;
    accountCurrency?: string;
    currentBalance?: number;
    accountType?: string;
    commodityNamespace?: string;  // NEW
}
```

Add `commodityNamespace` to the destructuring (line 45).

- [ ] **Step 2: Add investment detection and column switching**

After `const isMobile = useIsMobile();`:

```typescript
const isInvestmentAccount = commodityNamespace !== undefined && commodityNamespace !== 'CURRENCY';
```

Update the `columns` useMemo (line 452):

```typescript
import { getColumns, getInvestmentColumns } from './ledger/columns';

const columns = useMemo(() => {
    const colFn = isInvestmentAccount ? getInvestmentColumns : getColumns;
    return colFn({
        accountGuid,
        isReconciling,
        isEditMode,
    });
}, [accountGuid, isReconciling, isEditMode, isInvestmentAccount]);
```

- [ ] **Step 3: Compute investment row data**

Add imports:

```typescript
import { transformToInvestmentRow, InvestmentRowData } from './ledger/investment-utils';
```

Add useMemo after `displayTransactions`:

```typescript
const investmentRowMap = useMemo(() => {
    if (!isInvestmentAccount) return null;
    const map = new Map<string, InvestmentRowData>();
    displayTransactions.forEach(tx => {
        const row = transformToInvestmentRow(tx as AccountTransaction & { share_balance?: string; cost_basis?: string }, accountGuid);
        map.set(row.guid, row);
    });
    return map;
}, [isInvestmentAccount, displayTransactions, accountGuid]);
```

- [ ] **Step 4: Render investment cell content in the table body**

In the cell rendering section of the `<tbody>`, find where cells are rendered by `cell.column.id`. Add cases for investment columns. The pattern matches existing `debit`/`credit`/`balance` rendering:

```typescript
const invRow = investmentRowMap?.get(tx.guid);

// For 'shares':
if (cell.column.id === 'shares' && invRow) {
    if (invRow.shares !== null) {
        const color = invRow.shares > 0 ? 'text-emerald-400' : 'text-rose-400';
        return <td key={cell.id} className={`px-2 text-right text-sm ${color}`}>{invRow.shares.toFixed(4)}</td>;
    }
    return <td key={cell.id} className="px-2 text-right text-sm opacity-30">—</td>;
}

// For 'price':
if (cell.column.id === 'price' && invRow) {
    if (invRow.price !== null) {
        return <td key={cell.id} className="px-2 text-right text-sm">{formatCurrency(invRow.price, tx.commodity_mnemonic)}</td>;
    }
    return <td key={cell.id} className="px-2 text-right text-sm opacity-30">—</td>;
}

// For 'buy':
if (cell.column.id === 'buy' && invRow) {
    if (invRow.buyAmount !== null) {
        return <td key={cell.id} className="px-2 text-right text-sm text-emerald-400">{formatCurrency(invRow.buyAmount, tx.commodity_mnemonic)}</td>;
    }
    return <td key={cell.id} className="px-2 text-right text-sm opacity-30">—</td>;
}

// For 'sell':
if (cell.column.id === 'sell' && invRow) {
    if (invRow.sellAmount !== null) {
        return <td key={cell.id} className="px-2 text-right text-sm text-rose-400">{formatCurrency(invRow.sellAmount, tx.commodity_mnemonic)}</td>;
    }
    return <td key={cell.id} className="px-2 text-right text-sm opacity-30">—</td>;
}

// For 'shareBalance':
if (cell.column.id === 'shareBalance' && invRow) {
    return <td key={cell.id} className="px-2 text-right text-sm">{invRow.shareBalance.toFixed(4)}</td>;
}

// For 'costBasis':
if (cell.column.id === 'costBasis' && invRow) {
    return <td key={cell.id} className="px-2 text-right text-sm">{formatCurrency(invRow.costBasis, tx.commodity_mnemonic)}</td>;
}
```

- [ ] **Step 5: Update LedgerMeta type**

In `src/components/ledger/types.ts`:

```typescript
export interface LedgerMeta {
    accountGuid: string;
    accountType: string;
    isReconciling: boolean;
    isEditMode: boolean;
    focusedRowIndex: number;
    editingGuid: string | null;
    balanceReversal: string;
    isInvestmentAccount: boolean;  // NEW
}
```

- [ ] **Step 6: Verify the build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/AccountLedger.tsx src/components/ledger/columns.tsx src/components/ledger/types.ts
git commit -m "feat: wire investment columns into AccountLedger with cell rendering"
```

---

## Chunk 3: Page Integration

### Task 5: Update the account page to pass investment props

**Files:**
- Modify: `src/app/(main)/accounts/[guid]/page.tsx`

- [ ] **Step 1: Pass commodityNamespace to AccountLedger**

At line 166, add the new prop:

```typescript
<AccountLedger
    accountGuid={guid}
    initialTransactions={transactions}
    startDate={startDate}
    endDate={endDate}
    accountType={account?.account_type}
    commodityNamespace={account?.commodity_namespace}
/>
```

- [ ] **Step 2: Verify by navigating to an investment account**

Run: `npm run dev`
Navigate to a STOCK account. Verify:
- Investment columns appear (Date, Description, Transfer, Shares, Price, Buy, Sell, Share Bal, Cost Basis)
- Data populates correctly
- Running share balance and cost basis are correct (computed server-side)

- [ ] **Step 3: Commit**

```bash
git add src/app/(main)/accounts/[guid]/page.tsx
git commit -m "feat: pass commodityNamespace from account page to AccountLedger"
```

---

### Task 6: Clean up InvestmentAccount component

Remove the duplicate "Transaction History" table from `InvestmentAccount.tsx`.

**Files:**
- Modify: `src/components/InvestmentAccount.tsx`

- [ ] **Step 1: Remove the Transaction History section**

Find the "Transaction History" heading and its associated table (renders Date, Description, Action, Shares, Amount). Remove that entire section. Keep:
- Price chart and zoom controls
- Holdings summary (shares, cost basis, market value, gain/loss)
- Price entry form and fetch button
- Period filter buttons

- [ ] **Step 2: Verify the page looks correct**

Run: `npm run dev`
Navigate to a STOCK account. Verify:
- Price chart and holdings still appear
- No duplicate transaction table
- Investment ledger with new columns appears below

- [ ] **Step 3: Commit**

```bash
git add src/components/InvestmentAccount.tsx
git commit -m "refactor: remove Transaction History from InvestmentAccount (replaced by investment ledger)"
```

---

## Chunk 4: Edit Mode

### Task 7: Create InvestmentEditRow component

Inline edit form with the 3-field auto-calc triangle (shares/price/total). Follows existing keyboard-driven `EditableRow` patterns.

**Files:**
- Create: `src/components/ledger/InvestmentEditRow.tsx`

- [ ] **Step 1: Create the component**

Key design decisions from the review:
- **No `useEffect` for auto-calc** — use derived state (computed during render) to avoid infinite loops
- **`useImperativeHandle` has correct deps** — `[save, isDirty]`
- **`isDirty` checks all fields** — including price and total

```typescript
'use client';
import { useState, useCallback, useImperativeHandle, forwardRef, useRef } from 'react';
import { AccountTransaction } from '@/components/AccountLedger';
import { DateCell } from './cells/DateCell';
import { DescriptionCell } from './cells/DescriptionCell';
import { AccountCell } from './cells/AccountCell';

export interface InvestmentEditRowHandle {
    save: () => Promise<boolean>;
    isDirty: () => boolean;
}

interface InvestmentEditRowProps {
    transaction: AccountTransaction;
    accountGuid: string;
    isActive: boolean;
    showCheckbox: boolean;
    isChecked: boolean;
    onToggleCheck: (e?: React.MouseEvent) => void;
    onSave: (guid: string, data: {
        post_date: string;
        description: string;
        transferAccountGuid: string;
        transferAccountName: string;
        shares: number;
        totalValue: number;
        isBuy: boolean;
    }) => Promise<void>;
    onEditModal: (guid: string) => void;
    columnCount: number;
    onClick?: () => void;
    focusedColumn?: number;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    onColumnFocus?: (columnIndex: number) => void;
}

export const InvestmentEditRow = forwardRef<InvestmentEditRowHandle, InvestmentEditRowProps>(
    function InvestmentEditRow({
        transaction,
        accountGuid,
        isActive,
        showCheckbox,
        isChecked,
        onToggleCheck,
        onSave,
        onEditModal,
        onClick,
        focusedColumn,
        onEnter,
        onArrowUp,
        onArrowDown,
        onColumnFocus,
    }, ref) {
        const isMultiSplit = (transaction.splits?.length || 0) > 2;

        const accountSplit = transaction.splits?.find(s => s.account_guid === accountGuid);
        const otherSplits = transaction.splits?.filter(s =>
            s.account_guid !== accountGuid &&
            !s.account_fullname?.startsWith('Trading:')
        ) || [];
        const transferSplit = otherSplits.length > 0
            ? otherSplits.reduce((best, s) => {
                const bestVal = Math.abs(parseFloat(best.value_decimal));
                const sVal = Math.abs(parseFloat(s.value_decimal));
                return sVal > bestVal ? s : best;
            })
            : null;

        const initShares = accountSplit ? parseFloat(accountSplit.quantity_decimal) : 0;
        const initValue = accountSplit ? Math.abs(parseFloat(accountSplit.value_decimal)) : 0;
        const initPrice = initShares !== 0 ? initValue / Math.abs(initShares) : 0;

        const [postDate, setPostDate] = useState(
            transaction.post_date ? new Date(transaction.post_date).toISOString().split('T')[0] : ''
        );
        const [description, setDescription] = useState(transaction.description || '');
        const [transferAccountGuid, setTransferAccountGuid] = useState(transferSplit?.account_guid || '');
        const [transferAccountName, setTransferAccountName] = useState(transferSplit?.account_name || '');
        const [sharesStr, setSharesStr] = useState(initShares !== 0 ? Math.abs(initShares).toString() : '');
        const [isBuy, setIsBuy] = useState(initShares >= 0);

        // Auto-calc: which field is user-driven vs derived
        // 'price' = price is auto-calculated (default), 'total' = total is auto-calculated
        const [autoCalcField, setAutoCalcField] = useState<'price' | 'total'>('price');

        // User-entered values for the two non-auto fields
        // When autoCalcField === 'price': user enters shares + total, price is derived
        // When autoCalcField === 'total': user enters shares + price, total is derived
        const [userPriceStr, setUserPriceStr] = useState(initPrice !== 0 ? initPrice.toFixed(4) : '');
        const [userTotalStr, setUserTotalStr] = useState(initValue !== 0 ? initValue.toFixed(2) : '');

        // Derived values (computed during render, no useEffect needed)
        const sharesNum = parseFloat(sharesStr);
        const userPrice = parseFloat(userPriceStr);
        const userTotal = parseFloat(userTotalStr);

        let displayPrice: string;
        let displayTotal: string;

        if (autoCalcField === 'price') {
            // Price is derived from shares + total
            displayTotal = userTotalStr;
            displayPrice = (!isNaN(sharesNum) && sharesNum > 0 && !isNaN(userTotal) && userTotal > 0)
                ? (userTotal / sharesNum).toFixed(4)
                : userPriceStr; // fallback to last known value
        } else {
            // Total is derived from shares + price
            displayPrice = userPriceStr;
            displayTotal = (!isNaN(sharesNum) && sharesNum > 0 && !isNaN(userPrice) && userPrice > 0)
                ? (sharesNum * userPrice).toFixed(2)
                : userTotalStr;
        }

        const handlePriceFocus = () => setAutoCalcField('total');
        const handleTotalFocus = () => setAutoCalcField('price');

        const isDirty = useCallback(() => {
            const origDate = transaction.post_date ? new Date(transaction.post_date).toISOString().split('T')[0] : '';
            return postDate !== origDate
                || description !== (transaction.description || '')
                || transferAccountGuid !== (transferSplit?.account_guid || '')
                || sharesStr !== (initShares !== 0 ? Math.abs(initShares).toString() : '')
                || isBuy !== (initShares >= 0)
                || userPriceStr !== (initPrice !== 0 ? initPrice.toFixed(4) : '')
                || userTotalStr !== (initValue !== 0 ? initValue.toFixed(2) : '');
        }, [postDate, description, transferAccountGuid, sharesStr, isBuy, userPriceStr, userTotalStr, transaction, transferSplit, initShares, initPrice, initValue]);

        const save = useCallback(async () => {
            if (!isDirty()) return true;
            const shares = parseFloat(sharesStr);
            const total = parseFloat(autoCalcField === 'price' ? userTotalStr : displayTotal);
            if (isNaN(shares) || isNaN(total)) return false;

            await onSave(transaction.guid, {
                post_date: postDate,
                description,
                transferAccountGuid,
                transferAccountName,
                shares: isBuy ? shares : -shares,
                totalValue: total,
                isBuy,
            });
            return true;
        }, [isDirty, sharesStr, userTotalStr, displayTotal, autoCalcField, postDate, description, transferAccountGuid, transferAccountName, isBuy, onSave, transaction.guid]);

        useImperativeHandle(ref, () => ({ save, isDirty }), [save, isDirty]);

        if (isMultiSplit) {
            return (
                <tr className="opacity-60 cursor-pointer" onClick={() => onEditModal(transaction.guid)}>
                    <td colSpan={99} className="px-3 py-2 text-sm italic">
                        Multi-split transaction — click to edit in modal
                    </td>
                </tr>
            );
        }

        const handleKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); onArrowUp?.(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); onArrowDown?.(); }
        };

        return (
            <tr className={`border-b border-border/50 ${isActive ? 'bg-emerald-500/10' : ''}`} onKeyDown={handleKeyDown}>
                {showCheckbox && (
                    <td className="px-1 text-center">
                        <input type="checkbox" checked={isChecked} onChange={() => onToggleCheck()} />
                    </td>
                )}
                <td className="px-1 text-center text-xs">{transaction.account_split_reconcile_state?.toUpperCase()}</td>
                <td className="px-2">
                    <DateCell value={postDate} onChange={setPostDate} autoFocus={focusedColumn === 0} />
                </td>
                <td className="px-2">
                    <DescriptionCell value={description} onChange={setDescription} autoFocus={focusedColumn === 1} />
                </td>
                <td className="px-2">
                    <AccountCell
                        value={transferAccountGuid}
                        onChange={(guid, name) => { setTransferAccountGuid(guid); setTransferAccountName(name); }}
                        autoFocus={focusedColumn === 2}
                        accountGuid={accountGuid}
                    />
                </td>
                <td className="px-2 text-right">
                    <input
                        type="number"
                        step="any"
                        className="w-20 bg-transparent border-b border-border/50 text-right text-sm focus:border-emerald-400 focus:outline-none"
                        value={sharesStr}
                        onChange={e => setSharesStr(e.target.value)}
                        autoFocus={focusedColumn === 3}
                    />
                </td>
                <td className={`px-2 text-right ${autoCalcField === 'price' ? 'opacity-60 italic' : ''}`}>
                    <input
                        type="number"
                        step="any"
                        className="w-20 bg-transparent border-b border-border/50 text-right text-sm focus:border-emerald-400 focus:outline-none"
                        value={autoCalcField === 'price' ? displayPrice : userPriceStr}
                        onChange={e => { setUserPriceStr(e.target.value); setAutoCalcField('total'); }}
                        onFocus={handlePriceFocus}
                        autoFocus={focusedColumn === 4}
                    />
                </td>
                <td className="px-2 text-right">
                    {isBuy ? (
                        <input
                            type="number"
                            step="any"
                            className={`w-24 bg-transparent border-b border-border/50 text-right text-sm text-emerald-400 focus:border-emerald-400 focus:outline-none ${autoCalcField === 'total' ? 'opacity-60 italic' : ''}`}
                            value={autoCalcField === 'total' ? displayTotal : userTotalStr}
                            onChange={e => { setUserTotalStr(e.target.value); setIsBuy(true); setAutoCalcField('price'); }}
                            onFocus={handleTotalFocus}
                            autoFocus={focusedColumn === 5}
                        />
                    ) : (
                        <span className="opacity-30 cursor-pointer text-sm" onClick={() => setIsBuy(true)}>—</span>
                    )}
                </td>
                <td className="px-2 text-right">
                    {!isBuy ? (
                        <input
                            type="number"
                            step="any"
                            className={`w-24 bg-transparent border-b border-border/50 text-right text-sm text-rose-400 focus:border-emerald-400 focus:outline-none ${autoCalcField === 'total' ? 'opacity-60 italic' : ''}`}
                            value={autoCalcField === 'total' ? displayTotal : userTotalStr}
                            onChange={e => { setUserTotalStr(e.target.value); setIsBuy(false); setAutoCalcField('price'); }}
                            onFocus={handleTotalFocus}
                            autoFocus={focusedColumn === 6}
                        />
                    ) : (
                        <span className="opacity-30 cursor-pointer text-sm" onClick={() => setIsBuy(false)}>—</span>
                    )}
                </td>
                <td className="px-2 text-right text-sm opacity-50">—</td>
                <td className="px-2 text-right text-sm opacity-50">—</td>
            </tr>
        );
    }
);
```

- [ ] **Step 2: Wire InvestmentEditRow into AccountLedger**

In `AccountLedger.tsx`, where `EditableRow` is rendered for edit mode rows, add a conditional:

```typescript
import { InvestmentEditRow, InvestmentEditRowHandle } from './ledger/InvestmentEditRow';

// In the row rendering section, wrap the existing EditableRow:
{isInvestmentAccount ? (
    <InvestmentEditRow
        ref={(el) => { if (el) editableRowRefs.current.set(tx.guid, el); }}
        transaction={tx}
        accountGuid={accountGuid}
        isActive={focusedRowIndex === index}
        showCheckbox={isEditMode}
        isChecked={editSelectedGuids.has(tx.guid)}
        onToggleCheck={(e) => handleEditCheckToggle(index, tx.guid, e?.shiftKey || false)}
        onSave={handleInvestmentInlineSave}
        onEditModal={handleEditDirect}
        columnCount={columns.length}
        focusedColumn={focusedColumnIndex}
        onEnter={() => handleEditModeEnter(index)}
        onArrowUp={() => handleEditModeArrowUp(index)}
        onArrowDown={() => handleEditModeArrowDown(index)}
        onColumnFocus={setFocusedColumnIndex}
    />
) : (
    <EditableRow ... /> /* existing code unchanged */
)}
```

- [ ] **Step 3: Add the investment inline save handler**

Add in `AccountLedger.tsx`:

```typescript
const handleInvestmentInlineSave = useCallback(async (guid: string, data: {
    post_date: string;
    description: string;
    transferAccountGuid: string;
    transferAccountName: string;
    shares: number;
    totalValue: number;
    isBuy: boolean;
}) => {
    try {
        const tx = transactions.find(t => t.guid === guid);
        if (!tx) return;

        const absShares = Math.abs(data.shares);
        const { num: sharesNum, denom: sharesDenom } = toNumDenom(absShares);
        const { num: valueNum, denom: valueDenom } = toNumDenom(data.totalValue);

        const body = {
            currency_guid: tx.currency_guid,
            post_date: data.post_date,
            description: data.description,
            splits: [
                {
                    account_guid: accountGuid,
                    value_num: data.isBuy ? -valueNum : valueNum,
                    value_denom: valueDenom,
                    quantity_num: data.isBuy ? sharesNum : -sharesNum,
                    quantity_denom: sharesDenom,
                    reconcile_state: tx.account_split_reconcile_state || 'n',
                },
                {
                    account_guid: data.transferAccountGuid,
                    value_num: data.isBuy ? valueNum : -valueNum,
                    value_denom: valueDenom,
                    quantity_num: data.isBuy ? valueNum : -valueNum,
                    quantity_denom: valueDenom,
                    reconcile_state: 'n',
                },
            ],
        };

        const res = await fetch(`/api/transactions/${guid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.status === 409) {
            error('Transaction was modified by another user. Refreshing...');
            await fetchTransactions();
            return;
        }

        if (!res.ok) throw new Error('Failed to update');
        success('Transaction updated');
        await fetchTransactions();
    } catch (err) {
        console.error('Investment inline save failed:', err);
        error('Failed to update transaction');
    }
}, [transactions, accountGuid, fetchTransactions, success, error]);
```

- [ ] **Step 4: Verify edit mode works**

Run: `npm run dev`
Navigate to a STOCK account. Toggle edit mode (E key). Verify:
- Inline edit fields appear for Date, Description, Transfer, Shares, Price, Buy/Sell
- Auto-calc: enter shares + total → price auto-fills (dimmed)
- Click into price → type a value → total auto-fills instead
- Enter/arrow keys save and navigate
- Multi-split rows show "click to edit in modal"

- [ ] **Step 5: Commit**

```bash
git add src/components/ledger/InvestmentEditRow.tsx src/components/AccountLedger.tsx
git commit -m "feat: add InvestmentEditRow with auto-calc and wire into AccountLedger"
```

---

## Chunk 5: Mobile & Polish

### Task 8: Add investment-specific mobile card rendering

**Files:**
- Modify: `src/components/AccountLedger.tsx` (mobile rendering section)

- [ ] **Step 1: Add investment mobile card rendering**

In the mobile rendering path where `MobileCard` is used, add investment-specific layout when `isInvestmentAccount`:

```typescript
{isInvestmentAccount && invRow ? (
    <div className="bg-surface/30 backdrop-blur border border-border rounded-xl p-3 space-y-2">
        <div className="flex justify-between items-start">
            <div>
                <div className="text-xs text-foreground-muted">{new Date(tx.post_date).toLocaleDateString()}</div>
                <div className="text-sm font-medium">{tx.description}</div>
                <div className="text-xs text-foreground-muted">{invRow.transferAccount}</div>
            </div>
            <div className="text-right">
                {invRow.shares !== null && (
                    <div className={`text-sm font-mono ${invRow.shares > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {invRow.shares > 0 ? '+' : ''}{invRow.shares.toFixed(4)} shares
                    </div>
                )}
                {invRow.price !== null && (
                    <div className="text-xs text-foreground-muted">@ {formatCurrency(invRow.price, tx.commodity_mnemonic)}</div>
                )}
            </div>
        </div>
        <div className="flex justify-between text-xs border-t border-border/30 pt-1.5">
            {invRow.buyAmount !== null && (
                <span className="text-emerald-400">Buy: {formatCurrency(invRow.buyAmount, tx.commodity_mnemonic)}</span>
            )}
            {invRow.sellAmount !== null && (
                <span className="text-rose-400">Sell: {formatCurrency(invRow.sellAmount, tx.commodity_mnemonic)}</span>
            )}
            <span>Bal: {invRow.shareBalance.toFixed(4)}</span>
            <span>Cost: {formatCurrency(invRow.costBasis, tx.commodity_mnemonic)}</span>
        </div>
    </div>
) : (
    <MobileCard ... /> /* existing non-investment rendering */
)}
```

- [ ] **Step 2: Verify on mobile viewport**

Run: `npm run dev`
Use browser dev tools to set mobile viewport. Navigate to a STOCK account. Verify investment data shows in card format.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add investment-specific mobile card layout"
```

---

### Task 9: Final integration verification

- [ ] **Step 1: End-to-end verification**

Run: `npm run dev`

Verify all scenarios:
1. STOCK account → investment columns appear (not debit/credit)
2. Shares, prices, buy/sell amounts display correctly
3. Running share balance accumulates correctly (server-computed)
4. Running cost basis uses average cost method correctly
5. Dividend rows show blank shares/price/buy/sell
6. Transfer column shows correct counterpart account
7. Multi-split transactions (commissions) show primary cash account in Transfer
8. Edit mode: keyboard-driven, auto-calc triangle works
9. Multi-split rows in edit mode show "click to edit in modal"
10. Reconciliation mode works
11. Infinite scroll loads more with correct balances
12. Regular (non-investment) account → standard debit/credit columns unchanged
13. Mobile viewport → investment card layout

- [ ] **Step 2: Verify production build**

Run: `npm run build`
Expected: Build succeeds with zero errors.

- [ ] **Step 3: Final commit if any remaining changes**

```bash
git add -A
git commit -m "polish: investment ledger final integration fixes"
```
