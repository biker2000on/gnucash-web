/**
 * SCOPE OF THESE ORDERING TESTS (read before trusting them)
 *
 * They assert the ORDER in which statements are issued against a mocked
 * Prisma client: that the `FOR UPDATE` lock statement is emitted before the
 * reconcile-state read, and the read before the write. That is exactly the
 * regression that has now recurred twice, so it is worth pinning.
 *
 * They do NOT prove:
 *   - that PostgreSQL actually acquires or holds the row lock (a no-op
 *     $queryRaw would satisfy every assertion here);
 *   - that a concurrent reconcile really blocks on it;
 *   - rollback behaviour, or that the canonical guid ordering prevents a real
 *     deadlock.
 *
 * Proving those needs two real database transactions and a barrier. That tier
 * now exists — `vitest.integration.config.ts`, run with
 * `npm run test:integration` against TEST_DATABASE_URL — and the real locking
 * behaviour is covered there by
 * `src/__tests__/integration/locking.integration.test.ts`. These mocked
 * ordering tests remain the fast guard against the statement order regressing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        accounts: { findUnique: vi.fn() },
        transactions: { findMany: vi.fn(), update: vi.fn() },
        splits: { findMany: vi.fn(), updateMany: vi.fn() },
        gnucash_web_transaction_tags: { deleteMany: vi.fn(), createMany: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $executeRawUnsafe: vi.fn(),
    },
}));

import prisma from '@/lib/prisma';
import {
    selectRecategorizeSplit,
    selectHistoryCounterSplit,
    isUncategorizedAccountName,
    replaceDescription,
    type RecategorizeSplitInfo,
} from '@/lib/bulk-edit';
import {
    planHistoricalApplication,
    applyHistoricalMatches,
    HISTORY_APPLY_CAP,
    type CategorizationRule,
} from '@/lib/services/categorization.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const GUIDS = {
    checking: 'checking0000000000000000000000aa',
    groceries: 'groceries000000000000000000000bb',
    dining: 'dining000000000000000000000000cc',
    imbalance: 'imbalance000000000000000000000dd',
    trading: 'trading0000000000000000000000ee',
    target: 'target000000000000000000000000ff',
    usd: 'usd000000000000000000000000000aa',
    eur: 'eur000000000000000000000000000bb',
};

let splitSeq = 0;
function split(overrides: Partial<RecategorizeSplitInfo> = {}): RecategorizeSplitInfo {
    return {
        guid: `split${String(splitSeq++).padStart(27, '0')}`,
        accountGuid: GUIDS.checking,
        accountName: 'Checking',
        accountType: 'BANK',
        commodityGuid: GUIDS.usd,
        ...overrides,
    };
}

function makeRule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
    return {
        id: 1,
        bookGuid: 'b'.repeat(32),
        pattern: 'king soopers',
        matchType: 'contains',
        accountGuid: GUIDS.target,
        priority: 0,
        enabled: true,
        hitCount: 0,
        lastHitAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/* selectRecategorizeSplit (bulk edit API semantics)                    */
/* ------------------------------------------------------------------ */

describe('selectRecategorizeSplit', () => {
    it('picks the single counter-split (the split NOT on the anchor account)', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const counter = split({ accountGuid: GUIDS.imbalance, accountName: 'Imbalance-USD' });
        const result = selectRecategorizeSplit([anchor, counter], {
            toAccountGuid: GUIDS.groceries,
            anchorAccountGuid: GUIDS.checking,
        });
        expect(result).toEqual({ ok: true, split: counter });
    });

    it('fails without an anchor or a fromAccountGuid', () => {
        const result = selectRecategorizeSplit([split()], { toAccountGuid: GUIDS.groceries });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/anchor/i);
    });

    it('skips ambiguous multi-split transactions (more than one counter-split candidate)', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const a = split({ accountGuid: GUIDS.groceries, accountName: 'Groceries', accountType: 'EXPENSE' });
        const b = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const result = selectRecategorizeSplit([anchor, a, b], {
            toAccountGuid: GUIDS.imbalance,
            anchorAccountGuid: GUIDS.checking,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/ambiguous: 2/);
    });

    it('ignores Trading splits when identifying the counter-split', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const trading = split({ accountGuid: GUIDS.trading, accountName: 'Trading:CURRENCY:USD', accountType: 'TRADING' });
        const counter = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const result = selectRecategorizeSplit([anchor, trading, counter], {
            toAccountGuid: GUIDS.groceries,
            anchorAccountGuid: GUIDS.checking,
        });
        expect(result).toEqual({ ok: true, split: counter });
    });

    it('with fromAccountGuid, only moves splits currently on the source account', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const dining = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const onSource = selectRecategorizeSplit([anchor, dining], {
            toAccountGuid: GUIDS.groceries,
            anchorAccountGuid: GUIDS.checking,
            fromAccountGuid: GUIDS.dining,
        });
        expect(onSource).toEqual({ ok: true, split: dining });

        // Transaction with no split on the source account is a no-op, not an error
        const notOnSource = selectRecategorizeSplit([anchor, dining], {
            toAccountGuid: GUIDS.groceries,
            anchorAccountGuid: GUIDS.checking,
            fromAccountGuid: GUIDS.imbalance,
        });
        expect(notOnSource).toEqual({ ok: true, split: null });
    });

    it('is a no-op when the counter-split is already on the target account', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const already = split({ accountGuid: GUIDS.groceries, accountName: 'Groceries', accountType: 'EXPENSE' });
        const result = selectRecategorizeSplit([anchor, already], {
            toAccountGuid: GUIDS.groceries,
            anchorAccountGuid: GUIDS.checking,
        });
        expect(result).toEqual({ ok: true, split: null });
    });
});

/* ------------------------------------------------------------------ */
/* selectHistoryCounterSplit (retroactive rule semantics)               */
/* ------------------------------------------------------------------ */

describe('selectHistoryCounterSplit', () => {
    it('recognizes Imbalance and Orphan accounts as uncategorized', () => {
        expect(isUncategorizedAccountName('Imbalance-USD')).toBe(true);
        expect(isUncategorizedAccountName('Orphan-USD')).toBe(true);
        expect(isUncategorizedAccountName('  imbalance-eur ')).toBe(true);
        expect(isUncategorizedAccountName('Groceries')).toBe(false);
        expect(isUncategorizedAccountName('My Imbalance')).toBe(false);
    });

    it('onlyUncategorized: picks the Imbalance counter-split', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const imb = split({ accountGuid: GUIDS.imbalance, accountName: 'Imbalance-USD' });
        const decision = selectHistoryCounterSplit([anchor, imb], {
            targetAccountGuid: GUIDS.target,
            onlyUncategorized: true,
        });
        expect(decision).toEqual({ kind: 'change', split: imb });
    });

    it('onlyUncategorized: excludes transactions whose counter-split is a real category', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const expense = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const decision = selectHistoryCounterSplit([anchor, expense], {
            targetAccountGuid: GUIDS.target,
            onlyUncategorized: true,
        });
        expect(decision).toEqual({ kind: 'none' });
    });

    it('onlyUncategorized=false: picks an EXPENSE/INCOME counter-split', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const expense = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const decision = selectHistoryCounterSplit([anchor, expense], {
            targetAccountGuid: GUIDS.target,
            onlyUncategorized: false,
        });
        expect(decision).toEqual({ kind: 'change', split: expense });
    });

    it('skips ambiguous transactions (more than one candidate counter-split)', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const a = split({ accountGuid: GUIDS.groceries, accountName: 'Groceries', accountType: 'EXPENSE' });
        const b = split({ accountGuid: GUIDS.dining, accountName: 'Dining', accountType: 'EXPENSE' });
        const decision = selectHistoryCounterSplit([anchor, a, b], {
            targetAccountGuid: GUIDS.target,
            onlyUncategorized: false,
        });
        expect(decision.kind).toBe('skip');
        if (decision.kind === 'skip') expect(decision.reason).toMatch(/ambiguous: 2/);
    });

    it('never selects a split already on the target account', () => {
        const anchor = split({ accountGuid: GUIDS.checking });
        const onTarget = split({ accountGuid: GUIDS.target, accountName: 'Groceries', accountType: 'EXPENSE' });
        const decision = selectHistoryCounterSplit([anchor, onTarget], {
            targetAccountGuid: GUIDS.target,
            onlyUncategorized: false,
        });
        expect(decision).toEqual({ kind: 'none' });
    });
});

/* ------------------------------------------------------------------ */
/* replaceDescription (bulk find-and-replace)                           */
/* ------------------------------------------------------------------ */

describe('replaceDescription', () => {
    it('replaces every occurrence, case-insensitively', () => {
        expect(replaceDescription('AMAZON mktp Amazon', 'amazon', 'AMZ')).toBe('AMZ mktp AMZ');
    });

    it('treats the find string as literal text, not a regex', () => {
        expect(replaceDescription('PAY (AUTO) #12', '(auto)', 'auto')).toBe('PAY auto #12');
    });

    it('treats $ in the replacement literally', () => {
        expect(replaceDescription('COST 12', 'COST', '$&VALUE')).toBe('$&VALUE 12');
    });

    it('returns the input unchanged for an empty find', () => {
        expect(replaceDescription('unchanged', '', 'x')).toBe('unchanged');
    });
});

/* ------------------------------------------------------------------ */
/* planHistoricalApplication (mocked prisma)                            */
/* ------------------------------------------------------------------ */

interface MockTx { guid: string; post_date: Date | null; description: string | null }
interface MockSplitRow {
    guid: string;
    tx_guid: string;
    value_num: bigint;
    value_denom: bigint;
    account: { guid: string; name: string; account_type: string; commodity_guid: string | null };
}

const TARGET_ACCOUNT = { guid: GUIDS.target, name: 'Groceries', commodity_guid: GUIDS.usd };
const BOOK_GUIDS = Object.values(GUIDS);

let txSeq = 0;
function mockTx(description: string, date = '2025-03-15'): MockTx {
    return {
        guid: `tx${String(txSeq++).padStart(30, '0')}`,
        post_date: new Date(`${date}T00:00:00Z`),
        description,
    };
}

function mockSplits(
    tx: MockTx,
    counter: { accountGuid: string; name: string; type: string; commodity?: string | null },
): MockSplitRow[] {
    return [
        {
            guid: `s-anchor-${tx.guid}`,
            tx_guid: tx.guid,
            value_num: -500n,
            value_denom: 100n,
            account: { guid: GUIDS.checking, name: 'Checking', account_type: 'BANK', commodity_guid: GUIDS.usd },
        },
        {
            guid: `s-counter-${tx.guid}`,
            tx_guid: tx.guid,
            value_num: 500n,
            value_denom: 100n,
            account: {
                guid: counter.accountGuid,
                name: counter.name,
                account_type: counter.type,
                commodity_guid: counter.commodity === undefined ? GUIDS.usd : counter.commodity,
            },
        },
    ];
}

function installPlanMocks(
    txs: MockTx[],
    allSplits: MockSplitRow[],
    originals: Array<{ tx_guid: string; original_description: string }> = [],
) {
    mockPrisma.accounts.findUnique.mockResolvedValue(TARGET_ACCOUNT);
    mockPrisma.transactions.findMany.mockResolvedValue(txs);
    // Preserved import-time payees (gnucash_web_transaction_meta.original_description)
    mockPrisma.$queryRaw.mockResolvedValue(originals);
    mockPrisma.splits.findMany.mockImplementation(async (args: { where: { tx_guid: { in: string[] } } }) => {
        const wanted = new Set(args.where.tx_guid.in);
        return allSplits.filter(s => wanted.has(s.tx_guid));
    });
}

describe('planHistoricalApplication', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reuses import-time matching semantics: contains', async () => {
        const hit = mockTx('KING SOOPERS #0123 DENVER CO');
        const miss = mockTx('COSTCO WHOLESALE');
        installPlanMocks([hit, miss], [
            ...mockSplits(hit, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
            ...mockSplits(miss, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
        ]);

        const plan = await planHistoricalApplication(
            makeRule({ pattern: 'king soopers', matchType: 'contains' }),
            BOOK_GUIDS,
        );
        expect(plan.matches.map(m => m.guid)).toEqual([hit.guid]);
        expect(plan.matches[0]).toMatchObject({
            splitGuid: `s-counter-${hit.guid}`,
            date: '2025-03-15',
            currentAccount: 'Imbalance-USD',
            newAccountGuid: GUIDS.target,
            newAccount: 'Groceries',
            amount: 5,
        });
        expect(plan.moreRemain).toBe(false);
    });

    it('matches on the preserved import payee, not the renamed description', async () => {
        // Renamed import: displayed as "pajamas", arrived as HARBOR FREIGHT.
        const renamed = mockTx('pajamas');
        // Manual transaction whose display text happens to contain the pattern
        // but has no preserved payee — still matches via description fallback.
        const manual = mockTx('Harbor Freight sanding discs');
        const miss = mockTx('COSTCO WHOLESALE');
        installPlanMocks(
            [renamed, manual, miss],
            [
                ...mockSplits(renamed, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
                ...mockSplits(manual, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
                ...mockSplits(miss, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
            ],
            [{ tx_guid: renamed.guid, original_description: 'HARBOR FREIGHT PAYMENT' }],
        );

        const plan = await planHistoricalApplication(
            makeRule({ pattern: 'harbor freight', matchType: 'contains' }),
            BOOK_GUIDS,
        );
        expect(plan.matches.map(m => m.guid)).toEqual([renamed.guid, manual.guid]);
        // The SQL prefilter must not drop renamed imports whose display
        // description does not contain the pattern.
        const findManyWhere = mockPrisma.transactions.findMany.mock.calls[0][0].where;
        expect(findManyWhere.OR).toEqual(expect.arrayContaining([
            { guid: { in: [renamed.guid] } },
        ]));
    });

    it('reuses import-time matching semantics: exact', async () => {
        const hit = mockTx('  Payroll Deposit  ');
        const miss = mockTx('PAYROLL DEPOSIT EXTRA');
        installPlanMocks([hit, miss], [
            ...mockSplits(hit, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
            ...mockSplits(miss, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
        ]);

        const plan = await planHistoricalApplication(
            makeRule({ pattern: 'payroll deposit', matchType: 'exact' }),
            BOOK_GUIDS,
        );
        expect(plan.matches.map(m => m.guid)).toEqual([hit.guid]);
    });

    it('reuses import-time matching semantics: regex (invalid regex never matches)', async () => {
        const hit = mockTx('KING SOOPERS #0123');
        const miss = mockTx('KING SOOPERS STORE');
        installPlanMocks([hit, miss], [
            ...mockSplits(hit, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
            ...mockSplits(miss, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
        ]);

        const plan = await planHistoricalApplication(
            makeRule({ pattern: '^king\\s+soopers\\s+#\\d+', matchType: 'regex' }),
            BOOK_GUIDS,
        );
        expect(plan.matches.map(m => m.guid)).toEqual([hit.guid]);

        const invalid = await planHistoricalApplication(
            makeRule({ pattern: '([unclosed', matchType: 'regex' }),
            BOOK_GUIDS,
        );
        expect(invalid.matches).toEqual([]);
    });

    it('applies even when the rule is disabled (explicit user action)', async () => {
        const hit = mockTx('KING SOOPERS #1');
        installPlanMocks([hit], mockSplits(hit, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }));

        const plan = await planHistoricalApplication(makeRule({ enabled: false }), BOOK_GUIDS);
        expect(plan.matches).toHaveLength(1);
    });

    it('onlyUncategorized (default) skips already-categorized counter-splits; false includes them', async () => {
        const uncategorized = mockTx('KING SOOPERS #1');
        const categorized = mockTx('KING SOOPERS #2');
        const splits = [
            ...mockSplits(uncategorized, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }),
            ...mockSplits(categorized, { accountGuid: GUIDS.dining, name: 'Dining', type: 'EXPENSE' }),
        ];
        installPlanMocks([uncategorized, categorized], splits);

        const safe = await planHistoricalApplication(makeRule(), BOOK_GUIDS);
        expect(safe.matches.map(m => m.guid)).toEqual([uncategorized.guid]);
        expect(safe.skipped).toEqual([]);

        installPlanMocks([uncategorized, categorized], splits);
        const aggressive = await planHistoricalApplication(makeRule(), BOOK_GUIDS, { onlyUncategorized: false });
        expect(aggressive.matches.map(m => m.guid).sort()).toEqual([uncategorized.guid, categorized.guid].sort());
    });

    it('reports ambiguous multi-split transactions as skipped', async () => {
        const ambiguous = mockTx('KING SOOPERS AMBIG');
        const rows = mockSplits(ambiguous, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' });
        rows.push({
            guid: `s-extra-${ambiguous.guid}`,
            tx_guid: ambiguous.guid,
            value_num: 100n,
            value_denom: 100n,
            account: { guid: GUIDS.groceries, name: 'Orphan-USD', account_type: 'BANK', commodity_guid: GUIDS.usd },
        });
        installPlanMocks([ambiguous], rows);

        const plan = await planHistoricalApplication(makeRule(), BOOK_GUIDS);
        expect(plan.matches).toEqual([]);
        expect(plan.skipped).toHaveLength(1);
        expect(plan.skipped[0]).toMatchObject({ guid: ambiguous.guid, reason: expect.stringMatching(/ambiguous: 2/) });
    });

    it('skips counter-splits whose commodity differs from the target account', async () => {
        const mismatched = mockTx('KING SOOPERS EUR');
        installPlanMocks(
            [mismatched],
            mockSplits(mismatched, { accountGuid: GUIDS.imbalance, name: 'Imbalance-EUR', type: 'BANK', commodity: GUIDS.eur }),
        );

        const plan = await planHistoricalApplication(makeRule(), BOOK_GUIDS);
        expect(plan.matches).toEqual([]);
        expect(plan.skipped[0].reason).toMatch(/currency mismatch/);
    });

    it('dry-run (planning) performs no writes', async () => {
        const hit = mockTx('KING SOOPERS #1');
        installPlanMocks([hit], mockSplits(hit, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }));

        await planHistoricalApplication(makeRule(), BOOK_GUIDS);

        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
        expect(mockPrisma.transactions.update).not.toHaveBeenCalled();
        expect(mockPrisma.gnucash_web_transaction_tags.deleteMany).not.toHaveBeenCalled();
        expect(mockPrisma.gnucash_web_transaction_tags.createMany).not.toHaveBeenCalled();
    });

    it(`caps at ${HISTORY_APPLY_CAP} changes and sets moreRemain (limit is clamped to the cap)`, async () => {
        const txs: MockTx[] = [];
        const splits: MockSplitRow[] = [];
        for (let i = 0; i < HISTORY_APPLY_CAP + 1; i++) {
            const tx = mockTx(`KING SOOPERS #${i}`);
            txs.push(tx);
            splits.push(...mockSplits(tx, { accountGuid: GUIDS.imbalance, name: 'Imbalance-USD', type: 'BANK' }));
        }
        installPlanMocks(txs, splits);

        // Ask for more than the cap; it must clamp
        const plan = await planHistoricalApplication(makeRule(), BOOK_GUIDS, { limit: HISTORY_APPLY_CAP + 100 });
        expect(plan.matches).toHaveLength(HISTORY_APPLY_CAP);
        expect(plan.moreRemain).toBe(true);
    });

    it('throws when the rule target account no longer exists', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue(null);
        await expect(planHistoricalApplication(makeRule(), BOOK_GUIDS)).rejects.toThrow(/target account/i);
    });
});

/* ------------------------------------------------------------------ */
/* applyHistoricalMatches                                              */
/* ------------------------------------------------------------------ */

describe('applyHistoricalMatches', () => {
    const SPLIT_1 = 'split1'.padEnd(32, '0');

    function match(overrides: Record<string, unknown> = {}) {
        return {
            guid: 'tx1'.padEnd(32, '0'),
            splitGuid: SPLIT_1,
            date: '2025-01-01',
            description: 'KING SOOPERS',
            currentAccountGuid: GUIDS.imbalance,
            currentAccount: 'Imbalance-USD',
            newAccountGuid: GUIDS.target,
            newAccount: 'Groceries',
            amount: 5,
            ...overrides,
        };
    }

    /**
     * Wire the interactive-transaction client. `protectedRows` is what the
     * reconciled-split lookup returns (empty = nothing reconciled).
     */
    function wireTx(updateMany: ReturnType<typeof vi.fn>, protectedRows: unknown[] = []) {
        const findMany = vi.fn().mockResolvedValue(protectedRows);
        const queryRaw = vi.fn().mockResolvedValue([]);
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
            fn({ splits: { updateMany, findMany }, $queryRaw: queryRaw })
        );
        return { findMany, queryRaw };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('moves each planned split inside one transaction, guarded on the planned source account', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        wireTx(updateMany);

        const result = await applyHistoricalMatches([match()]);

        expect(result.applied).toBe(1);
        expect(result.reconciledSkipped).toEqual([]);
        // The protected states are in the predicate too (belt and braces on
        // top of the parent-row lock), so the write itself can never land on
        // a reconciled row.
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                guid: SPLIT_1,
                account_guid: GUIDS.imbalance,
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: GUIDS.target },
        });
    });

    it('does not count splits that were concurrently moved away (guard misses)', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        wireTx(updateMany);

        const result = await applyHistoricalMatches([match()]);
        expect(result.applied).toBe(0);
    });

    it('is a no-op for an empty match list', async () => {
        const result = await applyHistoricalMatches([]);
        expect(result).toEqual({ applied: 0, reconciledSkipped: [] });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('refuses to re-book a %s split and names it in the result', async (_label, state) => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const { findMany } = wireTx(updateMany, [{
            guid: SPLIT_1,
            tx_guid: 'tx1'.padEnd(32, '0'),
            account_guid: GUIDS.imbalance,
            reconcile_state: state,
            account: { name: 'Imbalance-USD' },
        }]);

        const result = await applyHistoricalMatches([match()]);

        expect(result.applied).toBe(0);
        expect(updateMany).not.toHaveBeenCalled();
        expect(result.reconciledSkipped).toEqual([{
            splitGuid: SPLIT_1,
            txGuid: 'tx1'.padEnd(32, '0'),
            accountGuid: GUIDS.imbalance,
            accountName: 'Imbalance-USD',
            reconcileState: state,
        }]);
        // The reconcile state is read INSIDE the transaction, not from the plan.
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                reconcile_state: { in: ['y', 'f'] },
            }),
        }));
    });

    /* TOCTOU: a Prisma transaction alone takes no locks on a plain SELECT, so
       the reconcile-state read is only authoritative while the parent
       transaction rows are held FOR UPDATE. These two tests pin the ordering
       and the predicate that make the race impossible. */

    it('locks the parent transactions FOR UPDATE before reading reconcile state', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const { findMany, queryRaw } = wireTx(updateMany);

        await applyHistoricalMatches([match()]);

        const lockSql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
        expect(lockSql).toContain('FROM transactions');
        expect(lockSql).toContain('FOR UPDATE');
        expect(lockSql).toContain('ORDER BY guid');
        expect(queryRaw.mock.calls[0][1]).toEqual(['tx1'.padEnd(32, '0')]);
        // lock → read → write, in that order
        expect(queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(findMany.mock.invocationCallOrder[0]);
        expect(findMany.mock.invocationCallOrder[0])
            .toBeLessThan(updateMany.mock.invocationCallOrder[0]);
    });

    it('cannot write a split that got reconciled after the check (predicate backstop)', async () => {
        // Model the losing interleaving directly: the guard's read sees an
        // unreconciled split (nothing protected returned), but by the time the
        // write runs the row is 'y', so the predicate excludes it and the
        // updateMany reports zero rows. The applied count must reflect that
        // rather than claiming a change that never happened.
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        wireTx(updateMany, []);

        const result = await applyHistoricalMatches([match()]);

        expect(result.applied).toBe(0);
        expect(updateMany.mock.calls[0][0].where.reconcile_state).toEqual({ notIn: ['y', 'f'] });
    });

    it('still applies the unreconciled matches alongside a blocked one', async () => {
        const SPLIT_2 = 'split2'.padEnd(32, '0');
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        wireTx(updateMany, [{
            guid: SPLIT_1,
            tx_guid: 'tx1'.padEnd(32, '0'),
            account_guid: GUIDS.imbalance,
            reconcile_state: 'y',
            account: { name: 'Imbalance-USD' },
        }]);

        const result = await applyHistoricalMatches([
            match(),
            match({ guid: 'tx2'.padEnd(32, '0'), splitGuid: SPLIT_2 }),
        ]);

        expect(result.applied).toBe(1);
        expect(result.reconciledSkipped).toHaveLength(1);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                guid: SPLIT_2,
                account_guid: GUIDS.imbalance,
                reconcile_state: { notIn: ['y', 'f'] },
            },
            data: { account_guid: GUIDS.target },
        });
    });
});
