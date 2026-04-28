# Income Statement by Period — Transaction Drill-down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user click an amount cell in the Income Statement by Period report and see the underlying transactions in a modal (date · description · account · amount).

**Architecture:** A new `/api/reports/income-statement-by-period/transactions` endpoint resolves the clicked account's descendants in memory (matching how the parent report builds its hierarchy), fetches all matching splits in the given date range, applies the income sign-flip, and returns one row per split. A new `TransactionDrilldownModal` component consumes the endpoint; the page owns a single piece of state (`DrilldownTarget | null`) toggled by clicks on numeric cells.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma (PostgreSQL), Vitest + jsdom, Tailwind.

**Spec:** `docs/superpowers/specs/2026-04-28-income-statement-drilldown-design.md`

**Parallelism:** Tasks 1 and 3 are independent (server lib/route vs. modal component). Task 2 depends on Task 1. Task 4 depends on Tasks 2 and 3. Recommended subagent dispatch:
- Round A: Task 1 and Task 3 in parallel
- Round B: Task 2 (after 1)
- Round C: Task 4 (after 2 and 3)

---

## File Structure

**New files:**
- `src/lib/reports/income-statement-by-period-transactions.ts` — pure logic: descendant resolution, split shaping, sign flip. Exported function takes filters and returns the response shape.
- `src/lib/__tests__/income-statement-by-period-transactions.test.ts` — unit tests for the lib (mock `prisma`).
- `src/app/api/reports/income-statement-by-period/transactions/route.ts` — thin Next.js route handler: auth, parse query params, call the lib, return JSON.
- `src/components/reports/TransactionDrilldownModal.tsx` — the modal UI.

**Modified files:**
- `src/app/(main)/reports/income_statement_by_period/page.tsx` — add `DrilldownTarget` state, make amount cells clickable, render the modal.

---

## Task 1: Server-side drill-down lib + tests

**Files:**
- Create: `src/lib/reports/income-statement-by-period-transactions.ts`
- Test: `src/lib/__tests__/income-statement-by-period-transactions.test.ts`

This task ships the pure logic. The route in Task 2 is a thin wrapper around it.

- [ ] **Step 1: Write the failing test file**

Create `src/lib/__tests__/income-statement-by-period-transactions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock -----------------------------------------------------------
const mockAccountsFindMany = vi.fn();
const mockSplitsFindMany = vi.fn();

vi.mock('../prisma', () => ({
  default: {
    accounts: {
      findMany: (...args: unknown[]) => mockAccountsFindMany(...args),
    },
    splits: {
      findMany: (...args: unknown[]) => mockSplitsFindMany(...args),
    },
  },
}));

import { fetchPeriodTransactions } from '../reports/income-statement-by-period-transactions';

// --- Helpers --------------------------------------------------------------

function acct(guid: string, name: string, parent: string | null, type: 'INCOME' | 'EXPENSE') {
  return { guid, name, account_type: type, parent_guid: parent, hidden: 0 };
}

function split(opts: {
  txGuid: string;
  splitGuid: string;
  acctGuid: string;
  num: bigint;
  denom: bigint;
  date: string;
  description: string;
}) {
  return {
    guid: opts.splitGuid,
    tx_guid: opts.txGuid,
    account_guid: opts.acctGuid,
    quantity_num: opts.num,
    quantity_denom: opts.denom,
    transaction: {
      post_date: new Date(opts.date + 'T12:00:00Z'),
      enter_date: new Date(opts.date + 'T12:00:00Z'),
      description: opts.description,
    },
  };
}

beforeEach(() => {
  mockAccountsFindMany.mockReset();
  mockSplitsFindMany.mockReset();
});

// --- Tests ----------------------------------------------------------------

describe('fetchPeriodTransactions', () => {
  it('returns transactions for a leaf INCOME account with sign flipped', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('salary', 'Salary', 'income-root', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'salary', num: -500000n, denom: 100n, date: '2026-03-15', description: 'Paycheck' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'salary',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      txGuid: 't1',
      splitGuid: 's1',
      date: '2026-03-15',
      description: 'Paycheck',
      accountGuid: 'salary',
      accountName: 'Salary',
      amount: 5000,
    });
    expect(result.total).toBeCloseTo(5000, 2);
  });

  it('rolls up descendants for a parent account click', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('wages', 'Wages', 'income-root', 'INCOME'),
      acct('salary', 'Salary', 'wages', 'INCOME'),
      acct('bonus', 'Bonus', 'wages', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'salary', num: -500000n, denom: 100n, date: '2026-03-15', description: 'Paycheck' }),
      split({ txGuid: 't2', splitGuid: 's2', acctGuid: 'bonus',  num: -100000n, denom: 100n, date: '2026-03-20', description: 'Bonus' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'wages',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map(t => t.accountName).sort()).toEqual(['Bonus', 'Salary']);
    expect(result.total).toBeCloseTo(6000, 2);
    // Splits query should have been called with all three in-scope guids
    const splitsArgs = mockSplitsFindMany.mock.calls[0][0];
    expect(splitsArgs.where.account_guid.in.sort()).toEqual(['bonus', 'salary', 'wages'].sort());
  });

  it('does NOT flip sign for EXPENSE accounts', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('exp-root', 'Expenses', 'root', 'EXPENSE'),
      acct('groceries', 'Groceries', 'exp-root', 'EXPENSE'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1', acctGuid: 'groceries', num: 12345n, denom: 100n, date: '2026-03-10', description: 'Store' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'groceries',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions[0].amount).toBeCloseTo(123.45, 2);
    expect(result.total).toBeCloseTo(123.45, 2);
  });

  it('emits one row per split when a single transaction has multiple in-scope splits', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
      acct('wages', 'Wages', 'income-root', 'INCOME'),
      acct('salary', 'Salary', 'wages', 'INCOME'),
      acct('bonus', 'Bonus', 'wages', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([
      split({ txGuid: 't1', splitGuid: 's1a', acctGuid: 'salary', num: -400000n, denom: 100n, date: '2026-03-15', description: 'Payroll' }),
      split({ txGuid: 't1', splitGuid: 's1b', acctGuid: 'bonus',  num: -100000n, denom: 100n, date: '2026-03-15', description: 'Payroll' }),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'wages',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.total).toBeCloseTo(5000, 2);
  });

  it('returns empty when accountGuid is unknown', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('income-root', 'Income', 'root', 'INCOME'),
    ]);

    const result = await fetchPeriodTransactions({
      accountGuid: 'does-not-exist',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });

    expect(result.transactions).toEqual([]);
    expect(result.total).toBe(0);
    expect(mockSplitsFindMany).not.toHaveBeenCalled();
  });

  it('passes bookAccountGuids through to the accounts query', async () => {
    mockAccountsFindMany.mockResolvedValueOnce([
      acct('salary', 'Salary', 'root', 'INCOME'),
    ]);
    mockSplitsFindMany.mockResolvedValueOnce([]);

    await fetchPeriodTransactions({
      accountGuid: 'salary',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bookAccountGuids: ['salary', 'root'],
    });

    const acctArgs = mockAccountsFindMany.mock.calls[0][0];
    expect(acctArgs.where.guid).toEqual({ in: ['salary', 'root'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/income-statement-by-period-transactions.test.ts`
Expected: FAIL — module `../reports/income-statement-by-period-transactions` not found.

- [ ] **Step 3: Implement the lib**

Create `src/lib/reports/income-statement-by-period-transactions.ts`:

```typescript
import prisma from '@/lib/prisma';
import { toDecimal } from './utils';

export interface PeriodTransactionInput {
  accountGuid: string;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string;   // 'YYYY-MM-DD'
  bookAccountGuids?: string[];
}

export interface PeriodTransactionRow {
  txGuid: string;
  splitGuid: string;
  date: string;        // 'YYYY-MM-DD'
  description: string;
  accountGuid: string;
  accountName: string;
  amount: number;
}

export interface PeriodTransactionResponse {
  transactions: PeriodTransactionRow[];
  total: number;
}

interface AccountRow {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
}

function collectDescendants(
  byParent: Map<string | null, AccountRow[]>,
  rootGuid: string,
  out: AccountRow[],
): void {
  const children = byParent.get(rootGuid) ?? [];
  for (const child of children) {
    out.push(child);
    collectDescendants(byParent, child.guid, out);
  }
}

function toIsoDate(d: Date): string {
  // Use UTC components so we don't drift across timezones.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchPeriodTransactions(
  input: PeriodTransactionInput,
): Promise<PeriodTransactionResponse> {
  const { accountGuid, startDate, endDate, bookAccountGuids } = input;

  // 1. Fetch the candidate INCOME/EXPENSE accounts (same scope as the report itself).
  const accounts: AccountRow[] = await prisma.accounts.findMany({
    where: {
      ...(bookAccountGuids ? { guid: { in: bookAccountGuids } } : {}),
      account_type: { in: ['INCOME', 'EXPENSE'] },
      hidden: 0,
    },
    select: {
      guid: true,
      name: true,
      account_type: true,
      parent_guid: true,
    },
  });

  const byGuid = new Map(accounts.map(a => [a.guid, a]));
  const root = byGuid.get(accountGuid);
  if (!root) {
    return { transactions: [], total: 0 };
  }

  // 2. Resolve descendants in memory.
  const byParent = new Map<string | null, AccountRow[]>();
  for (const a of accounts) {
    const list = byParent.get(a.parent_guid) ?? [];
    list.push(a);
    byParent.set(a.parent_guid, list);
  }
  const inScope: AccountRow[] = [root];
  collectDescendants(byParent, root.guid, inScope);
  const inScopeGuids = inScope.map(a => a.guid);
  const nameByGuid = new Map(inScope.map(a => [a.guid, a.name]));

  // 3. Fetch every matching split.
  const rangeStart = new Date(startDate + 'T00:00:00');
  const rangeEnd = new Date(endDate + 'T23:59:59');

  const splits = await prisma.splits.findMany({
    where: {
      account_guid: { in: inScopeGuids },
      transaction: {
        post_date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: {
      guid: true,
      tx_guid: true,
      account_guid: true,
      quantity_num: true,
      quantity_denom: true,
      transaction: {
        select: {
          post_date: true,
          enter_date: true,
          description: true,
        },
      },
    },
  });

  // 4. Shape rows. Flip sign once at the top if the clicked account is INCOME
  //    so positive numbers represent inflows (matches the report's display).
  const flip = root.account_type === 'INCOME' ? -1 : 1;

  const rows: PeriodTransactionRow[] = splits.map(s => {
    const amount = flip * toDecimal(s.quantity_num, s.quantity_denom);
    return {
      txGuid: s.tx_guid,
      splitGuid: s.guid,
      date: s.transaction.post_date ? toIsoDate(s.transaction.post_date) : '',
      description: s.transaction.description ?? '',
      accountGuid: s.account_guid,
      accountName: nameByGuid.get(s.account_guid) ?? '',
      amount,
    };
  });

  // 5. Sort by date desc; stable on tx/split guid for deterministic order in tests.
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.txGuid !== b.txGuid) return a.txGuid < b.txGuid ? -1 : 1;
    return a.splitGuid < b.splitGuid ? -1 : 1;
  });

  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { transactions: rows, total };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/income-statement-by-period-transactions.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors related to the new file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/income-statement-by-period-transactions.ts src/lib/__tests__/income-statement-by-period-transactions.test.ts
git commit -m "feat(reports): drill-down lib for income statement by period"
```

---

## Task 2: API route handler

**Depends on:** Task 1.

**Files:**
- Create: `src/app/api/reports/income-statement-by-period/transactions/route.ts`

- [ ] **Step 1: Create the route handler**

Create `src/app/api/reports/income-statement-by-period/transactions/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { fetchPeriodTransactions } from '@/lib/reports/income-statement-by-period-transactions';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const accountGuid = searchParams.get('accountGuid');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        if (!accountGuid || !startDate || !endDate) {
            return NextResponse.json(
                { error: 'accountGuid, startDate, and endDate are required' },
                { status: 400 },
            );
        }

        const bookAccountGuids = await getBookAccountGuids();

        const result = await fetchPeriodTransactions({
            accountGuid,
            startDate,
            endDate,
            bookAccountGuids,
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Error fetching income-statement period transactions:', error);
        return NextResponse.json(
            { error: 'Failed to fetch transactions' },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors related to the new file.

- [ ] **Step 3: Sanity-check the build**

Run: `npm run build`
Expected: build succeeds. The new route should appear in the build output.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/income-statement-by-period/transactions/route.ts
git commit -m "feat(api): add income-statement-by-period drill-down endpoint"
```

---

## Task 3: TransactionDrilldownModal component

**Files:**
- Create: `src/components/reports/TransactionDrilldownModal.tsx`

This component is self-contained: it owns the fetch, the loading/error/empty states, and dismiss behavior. The page passes a `target` prop and an `onClose` callback.

- [ ] **Step 1: Create the modal component**

Create `src/components/reports/TransactionDrilldownModal.tsx`:

```typescript
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';

export interface DrilldownTarget {
    accountGuid: string;
    accountName: string;
    periodLabel: string;
    startDate: string;
    endDate: string;
}

interface DrilldownRow {
    txGuid: string;
    splitGuid: string;
    date: string;
    description: string;
    accountGuid: string;
    accountName: string;
    amount: number;
}

interface DrilldownResponse {
    transactions: DrilldownRow[];
    total: number;
}

interface Props {
    target: DrilldownTarget | null;
    onClose: () => void;
}

export function TransactionDrilldownModal({ target, onClose }: Props) {
    const [data, setData] = useState<DrilldownResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);

    // Fetch on target change
    useEffect(() => {
        if (!target) {
            setData(null);
            setError(null);
            return;
        }
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        setData(null);

        const params = new URLSearchParams({
            accountGuid: target.accountGuid,
            startDate: target.startDate,
            endDate: target.endDate,
        });

        fetch(`/api/reports/income-statement-by-period/transactions?${params}`)
            .then(async res => {
                if (!res.ok) throw new Error(`Failed (${res.status})`);
                return (await res.json()) as DrilldownResponse;
            })
            .then(json => {
                if (!cancelled) setData(json);
            })
            .catch(err => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [target]);

    // Esc to close + focus close button on open
    useEffect(() => {
        if (!target) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        closeBtnRef.current?.focus();
        return () => window.removeEventListener('keydown', onKey);
    }, [target, onClose]);

    if (!target) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
            onClick={onClose}
            aria-hidden="false"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Transactions for ${target.accountName} ${target.periodLabel}`}
                className="w-full sm:max-w-3xl sm:max-h-[80vh] max-h-[90vh] flex flex-col bg-background border border-border sm:rounded-lg shadow-xl overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border">
                    <div>
                        <div className="text-base font-semibold text-foreground">{target.accountName}</div>
                        <div className="text-xs text-foreground-muted">{target.periodLabel}</div>
                    </div>
                    <button
                        ref={closeBtnRef}
                        onClick={onClose}
                        aria-label="Close"
                        className="text-foreground-muted hover:text-foreground p-1 rounded"
                    >
                        ✕
                    </button>
                </div>

                {/* Sub-header: count + total */}
                {data && (
                    <div className="flex items-center justify-between px-4 py-2 text-xs text-foreground-secondary bg-background-tertiary/30 border-b border-border">
                        <span>
                            {data.transactions.length}{' '}
                            {data.transactions.length === 1 ? 'transaction' : 'transactions'}
                        </span>
                        <span
                            className={`font-mono font-medium ${
                                data.total >= 0 ? 'text-foreground-secondary' : 'text-rose-400'
                            }`}
                        >
                            {formatCurrency(data.total, 'USD')}
                        </span>
                    </div>
                )}

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                    {isLoading && <DrilldownSkeleton />}
                    {error && (
                        <div className="px-4 py-6 text-sm text-rose-400">
                            {error}
                        </div>
                    )}
                    {data && data.transactions.length === 0 && !isLoading && (
                        <div className="px-4 py-6 text-sm text-foreground-muted text-center">
                            No transactions in this period.
                        </div>
                    )}
                    {data && data.transactions.length > 0 && (
                        <DrilldownRows rows={data.transactions} />
                    )}
                </div>
            </div>
        </div>
    );
}

function DrilldownSkeleton() {
    return (
        <ul className="divide-y divide-border/30">
            {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="px-4 py-3 animate-pulse">
                    <div className="h-3 w-24 bg-surface-hover rounded mb-2" />
                    <div className="h-3 w-3/4 bg-surface-hover rounded" />
                </li>
            ))}
        </ul>
    );
}

function DrilldownRows({ rows }: { rows: DrilldownRow[] }) {
    return (
        <>
            {/* Desktop table */}
            <table className="hidden sm:table w-full text-sm">
                <thead className="sticky top-0 bg-background-tertiary/80 backdrop-blur-sm">
                    <tr className="border-b border-border">
                        <th className="text-left px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Date</th>
                        <th className="text-left px-3 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Description</th>
                        <th className="text-left px-3 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Account</th>
                        <th className="text-right px-4 py-2 text-xs uppercase tracking-wider text-foreground-muted font-medium">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => (
                        <tr key={r.splitGuid} className="border-b border-border/30 hover:bg-surface-hover/30">
                            <td className="px-4 py-2 whitespace-nowrap text-foreground-secondary">
                                <Link
                                    href={`/accounts/${r.accountGuid}#tx-${r.txGuid}`}
                                    className="hover:underline"
                                >
                                    {r.date}
                                </Link>
                            </td>
                            <td className="px-3 py-2 text-foreground">{r.description || <span className="text-foreground-muted">—</span>}</td>
                            <td className="px-3 py-2 text-foreground-secondary">{r.accountName}</td>
                            <td className={`px-4 py-2 text-right font-mono ${r.amount >= 0 ? 'text-foreground' : 'text-rose-400'}`}>
                                {formatCurrency(r.amount, 'USD')}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* Mobile card list */}
            <ul className="sm:hidden divide-y divide-border/30">
                {rows.map(r => (
                    <li key={r.splitGuid}>
                        <Link
                            href={`/accounts/${r.accountGuid}#tx-${r.txGuid}`}
                            className="block px-4 py-3 hover:bg-surface-hover/30"
                        >
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="text-xs text-foreground-secondary">{r.date}</span>
                                <span className={`font-mono text-sm ${r.amount >= 0 ? 'text-foreground' : 'text-rose-400'}`}>
                                    {formatCurrency(r.amount, 'USD')}
                                </span>
                            </div>
                            <div className="text-sm text-foreground mt-0.5 truncate">
                                {r.description || <span className="text-foreground-muted">—</span>}
                            </div>
                            <div className="text-xs text-foreground-muted mt-0.5 truncate">{r.accountName}</div>
                        </Link>
                    </li>
                ))}
            </ul>
        </>
    );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors related to the new file.

- [ ] **Step 3: Commit**

```bash
git add src/components/reports/TransactionDrilldownModal.tsx
git commit -m "feat(reports): drill-down modal for income statement by period"
```

---

## Task 4: Wire clicks into the page

**Depends on:** Tasks 2 and 3.

**Files:**
- Modify: `src/app/(main)/reports/income_statement_by_period/page.tsx`

This task adds the `DrilldownTarget` state, makes amount cells clickable, and renders the modal. The work splits into three edits.

- [ ] **Step 1: Add the import and state**

Edit `src/app/(main)/reports/income_statement_by_period/page.tsx`.

After the existing imports at the top, add:

```typescript
import { TransactionDrilldownModal, DrilldownTarget } from '@/components/reports/TransactionDrilldownModal';
```

Inside `IncomeStatementByPeriodPage`, near the other `useState` calls (around line 70), add:

```typescript
const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);
```

- [ ] **Step 2: Update `PeriodicSectionRows` props and the cell rendering**

Replace the `PeriodicSectionRowsProps` interface and the `PeriodicSectionRows` function (currently lines 280–366) with this version:

```typescript
interface PeriodicSectionRowsProps {
    title: string;
    rows: PeriodicLineItem[];
    totals: number[];
    grandTotal: number;
    expanded: Set<string>;
    onToggle: (guid: string) => void;
    onCellClick: (target: DrilldownTarget) => void;
    periods: { label: string; startDate: string; endDate: string }[];
    isLast: boolean;
}

function PeriodicSectionRows({
    title,
    rows,
    totals,
    grandTotal,
    expanded,
    onToggle,
    onCellClick,
    periods,
}: PeriodicSectionRowsProps) {
    const totalLabel =
        periods.length > 0
            ? `${periods[0].label} – ${periods[periods.length - 1].label}`
            : 'Total';
    const totalStartDate = periods[0]?.startDate ?? '';
    const totalEndDate = periods[periods.length - 1]?.endDate ?? '';

    return (
        <>
            <tr className="bg-background-tertiary/40">
                <td
                    colSpan={totals.length + 2}
                    className="px-4 py-2 text-xs uppercase tracking-wider text-foreground-secondary font-bold border-t border-border"
                >
                    {title}
                </td>
            </tr>
            {rows.map(row => {
                const hasChildren = !!(row.children && row.children.length > 0);
                const isExpanded = expanded.has(row.guid);
                const depth = row.depth ?? 0;
                return (
                    <tr key={row.guid} className="hover:bg-surface-hover/30 transition-colors border-b border-border/30">
                        <td className="px-4 py-1.5 sticky left-0 bg-background" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                            <div className="flex items-center gap-1.5">
                                {hasChildren ? (
                                    <button
                                        onClick={() => onToggle(row.guid)}
                                        className="w-4 text-foreground-muted hover:text-foreground"
                                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                                    >
                                        {isExpanded ? '▼' : '▶'}
                                    </button>
                                ) : (
                                    <span className="w-4" />
                                )}
                                <span className="text-foreground">{row.name}</span>
                            </div>
                        </td>
                        {row.amounts.map((v, i) => {
                            const isZero = Math.abs(v) < 0.005;
                            const className = `text-right px-3 py-1.5 font-mono text-xs ${
                                isZero
                                    ? 'text-foreground-muted'
                                    : v >= 0
                                        ? 'text-foreground-secondary'
                                        : 'text-rose-400'
                            }`;
                            if (isZero) {
                                return (
                                    <td key={i} className={className}>
                                        {formatCurrency(v, 'USD')}
                                    </td>
                                );
                            }
                            return (
                                <td key={i} className={`${className} cursor-pointer hover:underline`}>
                                    <button
                                        type="button"
                                        className="w-full text-right hover:underline focus:outline-none focus:underline"
                                        onClick={() =>
                                            onCellClick({
                                                accountGuid: row.guid,
                                                accountName: row.name,
                                                periodLabel: periods[i].label,
                                                startDate: periods[i].startDate,
                                                endDate: periods[i].endDate,
                                            })
                                        }
                                    >
                                        {formatCurrency(v, 'USD')}
                                    </button>
                                </td>
                            );
                        })}
                        {(() => {
                            const v = row.total;
                            const isZero = Math.abs(v) < 0.005;
                            const cls = `text-right px-3 py-1.5 font-mono text-xs text-foreground font-medium border-l border-border`;
                            if (isZero) {
                                return (
                                    <td className={cls}>
                                        {formatCurrency(v, 'USD')}
                                    </td>
                                );
                            }
                            return (
                                <td className={`${cls} cursor-pointer`}>
                                    <button
                                        type="button"
                                        className="w-full text-right hover:underline focus:outline-none focus:underline"
                                        onClick={() =>
                                            onCellClick({
                                                accountGuid: row.guid,
                                                accountName: row.name,
                                                periodLabel: totalLabel,
                                                startDate: totalStartDate,
                                                endDate: totalEndDate,
                                            })
                                        }
                                    >
                                        {formatCurrency(v, 'USD')}
                                    </button>
                                </td>
                            );
                        })()}
                    </tr>
                );
            })}
            {/* Section total */}
            <tr className="bg-background-tertiary/30 border-t border-border font-medium">
                <td className="px-4 py-2 text-foreground sticky left-0 bg-background-tertiary/30">
                    Total {title}
                </td>
                {totals.map((v, i) => (
                    <td key={i} className="text-right px-3 py-2 font-mono text-foreground">
                        {formatCurrency(v, 'USD')}
                    </td>
                ))}
                <td className="text-right px-3 py-2 font-mono text-foreground border-l border-border">
                    {formatCurrency(grandTotal, 'USD')}
                </td>
            </tr>
        </>
    );
}
```

- [ ] **Step 3: Pass new props at the call site and render the modal**

In the JSX where `<PeriodicSectionRows ... />` is rendered (around line 238), add the two new props:

```typescript
<PeriodicSectionRows
    key={section.title}
    title={section.title}
    rows={rows}
    totals={section.totals}
    grandTotal={section.grandTotal}
    expanded={expanded}
    onToggle={toggleRow}
    onCellClick={setDrilldown}
    periods={reportData.periods}
    isLast={sectionIdx === visibleItemsBySection.length - 1}
/>
```

Then, just before the closing `</ReportViewer>` tag, add the modal:

```typescript
<TransactionDrilldownModal
    target={drilldown}
    onClose={() => setDrilldown(null)}
/>
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the lint**

Run: `npm run lint`
Expected: no errors in the changed files.

- [ ] **Step 6: Run the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Manual smoke test**

Run the dev server: `npm run dev`. In the browser:

1. Navigate to `/reports/income_statement_by_period`.
2. Click a non-zero per-period account cell → modal opens, transactions list, sub-header total matches the cell.
3. Click a parent account cell with multiple children → modal lists transactions across descendants, Account column shows the sub-account.
4. Click a Total column cell → modal shows transactions across the full date range.
5. Press Esc → closes. Click backdrop → closes. Click X → closes.
6. Click a transaction row → navigates to the account ledger.
7. Resize window to mobile width → modal switches to card list.

Report any UI deviations from `DESIGN.md`.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(main\)/reports/income_statement_by_period/page.tsx
git commit -m "feat(reports): make income statement by period cells drill into transactions"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers descendant resolution + sign flip + multi-split rows + bookAccountGuids passthrough. Task 2 covers the endpoint per spec. Task 3 covers modal layout (desktop table + mobile cards), states (loading/error/empty), dismiss (Esc/backdrop/X), accessibility (`role="dialog"`, focus management, real `<button>` cells). Task 4 covers click targets per spec — leaf, parent, Total column — and excludes section subtotal rows / Net Income / zero cells.
- **No placeholders:** every step has the exact code or command.
- **Type consistency:** `DrilldownTarget` is exported from the modal and reused in the page; `PeriodTransactionRow` shape on the server matches `DrilldownRow` on the client (renamed in scope but identical fields).
