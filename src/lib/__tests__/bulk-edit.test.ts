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

function installPlanMocks(txs: MockTx[], allSplits: MockSplitRow[]) {
    mockPrisma.accounts.findUnique.mockResolvedValue(TARGET_ACCOUNT);
    mockPrisma.transactions.findMany.mockResolvedValue(txs);
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
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('moves each planned split inside one transaction, guarded on the planned source account', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
            fn({ splits: { updateMany } })
        );

        const applied = await applyHistoricalMatches([
            {
                guid: 'tx1'.padEnd(32, '0'),
                splitGuid: 'split1'.padEnd(32, '0'),
                date: '2025-01-01',
                description: 'KING SOOPERS',
                currentAccountGuid: GUIDS.imbalance,
                currentAccount: 'Imbalance-USD',
                newAccountGuid: GUIDS.target,
                newAccount: 'Groceries',
                amount: 5,
            },
        ]);

        expect(applied).toBe(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { guid: 'split1'.padEnd(32, '0'), account_guid: GUIDS.imbalance },
            data: { account_guid: GUIDS.target },
        });
    });

    it('does not count splits that were concurrently moved away (guard misses)', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
            fn({ splits: { updateMany } })
        );

        const applied = await applyHistoricalMatches([
            {
                guid: 'tx1'.padEnd(32, '0'),
                splitGuid: 'split1'.padEnd(32, '0'),
                date: '2025-01-01',
                description: 'KING SOOPERS',
                currentAccountGuid: GUIDS.imbalance,
                currentAccount: 'Imbalance-USD',
                newAccountGuid: GUIDS.target,
                newAccount: 'Groceries',
                amount: 5,
            },
        ]);
        expect(applied).toBe(0);
    });

    it('is a no-op for an empty match list', async () => {
        const applied = await applyHistoricalMatches([]);
        expect(applied).toBe(0);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
});
