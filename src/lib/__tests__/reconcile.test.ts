import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        accounts: { findUnique: vi.fn() },
        splits: { findMany: vi.fn(), updateMany: vi.fn() },
        $queryRaw: vi.fn(),
        $transaction: vi.fn(),
    },
}));

import prisma from '@/lib/prisma';
import {
    toCents,
    computeDifference,
    computeDifferenceCents,
    getReconcileWorkspace,
    finalizeReconciliation,
    statementDateCutoff,
} from '@/lib/reconcile';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const ACCOUNT = 'account0000000000000000000000aaa';
const OTHER_ACCOUNT = 'account0000000000000000000000bbb';
const SPLIT_1 = 'split000000000000000000000000001';
const SPLIT_2 = 'split000000000000000000000000002';
const SPLIT_3 = 'split000000000000000000000000003';

const STATEMENT_DATE = new Date('2026-06-30T00:00:00.000Z');

/** A reconciled ('y') split row as returned by splits.findMany. */
function ySplit(cents: number, reconcileDate: string | null) {
    return {
        quantity_num: BigInt(cents),
        quantity_denom: BigInt(100),
        reconcile_date: reconcileDate ? new Date(reconcileDate) : null,
    };
}

/** A selected split row as loaded inside finalizeReconciliation. */
function selectedSplit(
    guid: string,
    cents: number,
    overrides: Partial<{
        account_guid: string;
        reconcile_state: string;
        post_date: Date | null;
    }> = {},
) {
    return {
        guid,
        account_guid: overrides.account_guid ?? ACCOUNT,
        reconcile_state: overrides.reconcile_state ?? 'n',
        quantity_num: BigInt(cents),
        quantity_denom: BigInt(100),
        transaction: {
            post_date:
                overrides.post_date !== undefined
                    ? overrides.post_date
                    : new Date('2026-06-15T00:00:00.000Z'),
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // Interactive transaction → run the callback against the same mock client.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb(mockPrisma),
    );
});

/* ------------------------------------------------------------------ */
/* computeDifference — integer-cents math                              */
/* ------------------------------------------------------------------ */

describe('computeDifference / computeDifferenceCents', () => {
    it('is exact for 0.1 + 0.2 style float-drift cases', () => {
        // 0.1 + 0.2 === 0.30000000000000004 in floats; cents math must be exact.
        expect(computeDifferenceCents(0.3, 0, [0.1, 0.2])).toBe(0);
        expect(computeDifference(0.3, 0, [0.1, 0.2])).toBe(0);
    });

    it('is exact for classic drift accumulations', () => {
        // 100 × $0.01 deposits against a $1.00 ending balance.
        const pennies = Array.from({ length: 100 }, () => 0.01);
        expect(computeDifferenceCents(1.0, 0, pennies)).toBe(0);
        // 1.03 − 0.42 drift case: ending 0.61, reconciled 0.42 + selected 0.19.
        expect(computeDifferenceCents(0.61, 0.42, [0.19])).toBe(0);
    });

    it('computes ending − (reconciled + Σ selected)', () => {
        expect(computeDifferenceCents(100.1, 100, [])).toBe(10);
        expect(computeDifference(100.1, 100, [])).toBeCloseTo(0.1);
        expect(computeDifference(50, 60, [])).toBe(-10);
    });

    it('handles negative (funds out) selected amounts', () => {
        expect(computeDifferenceCents(90, 100, [-10])).toBe(0);
        expect(computeDifferenceCents(90, 100, [-10.5])).toBe(50);
    });

    it('toCents rounds decimal amounts to integer cents', () => {
        expect(toCents(10.005)).toBe(1001);
        expect(toCents(-3.14)).toBe(-314);
        expect(toCents(0.1 + 0.2)).toBe(30);
    });
});

/* ------------------------------------------------------------------ */
/* statementDateCutoff                                                 */
/* ------------------------------------------------------------------ */

describe('statementDateCutoff', () => {
    it('extends the statement date to inclusive end-of-day UTC', () => {
        const cutoff = statementDateCutoff(new Date('2026-06-30T00:00:00.000Z'));
        expect(cutoff.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    });
});

/* ------------------------------------------------------------------ */
/* getReconcileWorkspace                                               */
/* ------------------------------------------------------------------ */

describe('getReconcileWorkspace', () => {
    it('throws not_found when the account does not exist', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue(null);
        await expect(getReconcileWorkspace(ACCOUNT, STATEMENT_DATE)).rejects.toMatchObject({
            name: 'ManualReconcileError',
            code: 'not_found',
        });
    });

    it('computes the reconciled balance and last reconcile date from y splits', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue({
            guid: ACCOUNT,
            name: 'Checking',
            account_type: 'BANK',
            commodity: { mnemonic: 'USD' },
        });
        mockPrisma.splits.findMany.mockResolvedValue([
            ySplit(10000, '2026-05-31T00:00:00.000Z'), // 100.00
            ySplit(2550, '2026-04-30T00:00:00.000Z'), //  25.50
            ySplit(-1000, '2026-05-31T00:00:00.000Z'), // -10.00
        ]);
        mockPrisma.$queryRaw.mockResolvedValue([
            {
                guid: SPLIT_1,
                memo: 'memo one',
                reconcile_state: 'c',
                quantity_num: BigInt(4200),
                quantity_denom: BigInt(100),
                post_date: new Date('2026-06-10T00:00:00.000Z'),
                num: '1042',
                description: 'Grocery store',
            },
            {
                guid: SPLIT_2,
                memo: null,
                reconcile_state: 'n',
                quantity_num: BigInt(-1550),
                quantity_denom: BigInt(100),
                post_date: new Date('2026-06-20T00:00:00.000Z'),
                num: null,
                description: null,
            },
        ]);

        const ws = await getReconcileWorkspace(ACCOUNT, STATEMENT_DATE);

        expect(ws.account).toEqual({
            guid: ACCOUNT,
            name: 'Checking',
            account_type: 'BANK',
            currency: 'USD',
        });
        expect(ws.reconciledBalance).toBe(115.5); // 100.00 + 25.50 − 10.00
        expect(ws.lastReconcileDate).toBe('2026-05-31T00:00:00.000Z');
        expect(ws.candidates).toEqual([
            {
                guid: SPLIT_1,
                date: '2026-06-10T00:00:00.000Z',
                num: '1042',
                description: 'Grocery store',
                memo: 'memo one',
                amount: 42,
                state: 'c',
            },
            {
                guid: SPLIT_2,
                date: '2026-06-20T00:00:00.000Z',
                num: '',
                description: '',
                memo: '',
                amount: -15.5,
                state: 'n',
            },
        ]);
        // Only 'y' splits feed the reconciled balance.
        expect(mockPrisma.splits.findMany).toHaveBeenCalledWith({
            where: { account_guid: ACCOUNT, reconcile_state: 'y' },
            select: { quantity_num: true, quantity_denom: true, reconcile_date: true },
        });
    });

    it('reports null last reconcile date and zero balance for a never-reconciled account', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue({
            guid: ACCOUNT,
            name: 'Checking',
            account_type: 'BANK',
            commodity: null,
        });
        mockPrisma.splits.findMany.mockResolvedValue([]);
        mockPrisma.$queryRaw.mockResolvedValue([]);

        const ws = await getReconcileWorkspace(ACCOUNT, STATEMENT_DATE);
        expect(ws.reconciledBalance).toBe(0);
        expect(ws.lastReconcileDate).toBeNull();
        expect(ws.account.currency).toBeNull();
        expect(ws.candidates).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* finalizeReconciliation                                              */
/* ------------------------------------------------------------------ */

describe('finalizeReconciliation', () => {
    /** Route splits.findMany by its where clause: selected lookup vs y-sum. */
    function mockSplitLookups(selected: unknown[], reconciled: unknown[]) {
        mockPrisma.splits.findMany.mockImplementation(async (args: any) => {
            if (args?.where?.guid?.in) return selected;
            if (args?.where?.reconcile_state === 'y') return reconciled;
            throw new Error(`Unexpected splits.findMany args: ${JSON.stringify(args)}`);
        });
    }

    it('rejects with the recomputed difference when it is non-zero', async () => {
        // reconciled 100.00, selected 50.00, ending 175.00 → difference 25.00
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 5000)],
            [ySplit(10000, '2026-05-31T00:00:00.000Z')],
        );

        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 175, [SPLIT_1]),
        ).rejects.toMatchObject({
            name: 'ManualReconcileError',
            code: 'not_zero',
            detail: { difference: 25, differenceCents: 2500 },
        });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('never trusts the client: uses DB amounts, not the request', async () => {
        // Ending balance says 150.00 but the DB's recomputed sum is 149.99.
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 4999)],
            [ySplit(10000, null)],
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 150, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'not_zero', detail: { differenceCents: 1 } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('sets exactly the requested splits to y with the statement date', async () => {
        // reconciled 100.00 + selected (42.00 − 15.50) = 126.50 = ending
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 4200), selectedSplit(SPLIT_2, -1550)],
            [ySplit(10000, '2026-05-31T00:00:00.000Z')],
        );
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 2 });

        const result = await finalizeReconciliation(
            ACCOUNT,
            STATEMENT_DATE,
            126.5,
            [SPLIT_1, SPLIT_2],
        );

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockPrisma.splits.updateMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.splits.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [SPLIT_1, SPLIT_2] }, account_guid: ACCOUNT },
            data: { reconcile_state: 'y', reconcile_date: STATEMENT_DATE },
        });
        expect(result).toEqual({
            reconciledSplits: 2,
            statementDate: STATEMENT_DATE.toISOString(),
            endingBalance: 126.5,
        });
    });

    it('deduplicates repeated split guids before validating and writing', async () => {
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 2650)],
            [ySplit(10000, null)],
        );
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });

        await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 126.5, [SPLIT_1, SPLIT_1]);
        expect(mockPrisma.splits.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [SPLIT_1] }, account_guid: ACCOUNT },
            data: { reconcile_state: 'y', reconcile_date: STATEMENT_DATE },
        });
    });

    it('rejects splits that do not exist', async () => {
        mockSplitLookups([selectedSplit(SPLIT_1, 1000)], []);
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1, SPLIT_3]),
        ).rejects.toMatchObject({ code: 'not_found', detail: { missing: [SPLIT_3] } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits belonging to a different account', async () => {
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 1000, { account_guid: OTHER_ACCOUNT })],
            [],
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request', detail: { splitGuids: [SPLIT_1] } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits that are already reconciled', async () => {
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 1000, { reconcile_state: 'y' })],
            [],
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request' });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits posted after the statement date', async () => {
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 1000, { post_date: new Date('2026-07-01T00:00:00.000Z') })],
            [],
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request' });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('allows a split posted on the statement date itself (end of day inclusive)', async () => {
        mockSplitLookups(
            [selectedSplit(SPLIT_1, 1000, { post_date: new Date('2026-06-30T10:59:00.000Z') })],
            [],
        );
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).resolves.toMatchObject({ reconciledSplits: 1 });
    });

    it('finalizes with zero selected splits when the difference is already zero', async () => {
        mockPrisma.splits.findMany.mockResolvedValue([ySplit(10000, null)]);
        const result = await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 100, []);
        expect(result.reconciledSplits).toBe(0);
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('uses an injected transaction client when provided (no new $transaction)', async () => {
        const txClient = {
            splits: {
                findMany: vi.fn(async (args: any) => {
                    if (args?.where?.guid?.in) return [selectedSplit(SPLIT_1, 2500)];
                    return [ySplit(10000, null)];
                }),
                updateMany: vi.fn(async () => ({ count: 1 })),
            },
        };

        const result = await finalizeReconciliation(
            ACCOUNT,
            STATEMENT_DATE,
            125,
            [SPLIT_1],
            txClient as any,
        );

        expect(result.reconciledSplits).toBe(1);
        expect(txClient.splits.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [SPLIT_1] }, account_guid: ACCOUNT },
            data: { reconcile_state: 'y', reconcile_date: STATEMENT_DATE },
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
});
