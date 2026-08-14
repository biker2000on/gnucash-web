import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {
        accounts: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
        books: { findUnique: vi.fn() },
        transactions: { create: vi.fn() },
        splits: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
        $queryRaw: vi.fn(),
        $executeRaw: vi.fn(),
        $transaction: vi.fn(),
    },
}));

import prisma from '@/lib/prisma';
import {
    toCents,
    computeDifference,
    computeDifferenceCents,
    toggleCandidateSelection,
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
const TX_1 = 'transaction000000000000000000001';
const TX_2 = 'transaction000000000000000000002';

const STATEMENT_DATE = new Date('2026-06-30T00:00:00.000Z');

/** Join a tagged-template SQL call into inspectable text. */
function sqlText(call: unknown[]): string {
    return (call[0] as TemplateStringsArray).join('?');
}

/** Row shape returned by the reconciled-balance SQL aggregate. */
function reconciledAggregateRow(cents: number | null, lastDate: string | null = null) {
    return [{
        reconciled_cents: cents === null ? null : BigInt(cents),
        last_reconcile_date: lastDate ? new Date(lastDate) : null,
    }];
}

/**
 * Route $queryRaw by SQL shape: advisory lock and FOR UPDATE row locks
 * return empty, the reconciled-balance aggregate returns the configured
 * sum/max, and the workspace's candidate/session queries return their rows.
 */
function mockQueryRawRouting(options: {
    reconciledCents?: number | null;
    lastReconcileDate?: string | null;
    candidates?: unknown[];
    sessions?: unknown[];
} = {}) {
    mockPrisma.$queryRaw.mockImplementation(async (template: TemplateStringsArray) => {
        const sql = template.join('?');
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FOR UPDATE')) return [];
        if (sql.includes('SUM(')) {
            return reconciledAggregateRow(
                options.reconciledCents ?? null,
                options.lastReconcileDate ?? null,
            );
        }
        if (sql.includes('gnucash_web_reconciliation_sessions')) return options.sessions ?? [];
        if (sql.includes('JOIN transactions')) return options.candidates ?? [];
        throw new Error(`Unexpected $queryRaw SQL: ${sql}`);
    });
}

/** A selected split row as loaded inside finalizeReconciliation. */
function selectedSplit(
    guid: string,
    cents: number,
    overrides: Partial<{
        tx_guid: string;
        account_guid: string;
        reconcile_state: string;
        post_date: Date | null;
    }> = {},
) {
    return {
        guid,
        tx_guid: overrides.tx_guid ?? TX_1,
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

/**
 * Wire up a finalize run: the selected-splits reads (pre-read for parent tx
 * guids + validated read) are served from `selected`, and the reconciled
 * balance comes from the SQL aggregate (`reconciledCents`, null = no 'y'
 * splits).
 */
function mockFinalize(selected: unknown[], reconciledCents: number | null) {
    mockPrisma.splits.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.guid?.in) return selected;
        throw new Error(`Unexpected splits.findMany args: ${JSON.stringify(args)}`);
    });
    mockQueryRawRouting({ reconciledCents });
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

describe('toggleCandidateSelection', () => {
    const candidates = [SPLIT_1, SPLIT_2, SPLIT_3].map((guid, index) => ({
        guid,
        transactionGuid: `transaction-${index + 1}`,
        date: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        num: '',
        description: `Candidate ${index + 1}`,
        memo: '',
        amount: index + 1,
        state: 'n' as const,
    }));

    it('toggles a normal click and selects an inclusive shift-click range', () => {
        const first = toggleCandidateSelection(candidates, new Set(), 0, null, false);
        expect([...first]).toEqual([SPLIT_1]);

        const range = toggleCandidateSelection(candidates, first, 2, 0, true);
        expect([...range]).toEqual([SPLIT_1, SPLIT_2, SPLIT_3]);

        const toggled = toggleCandidateSelection(candidates, range, 1, 2, false);
        expect([...toggled]).toEqual([SPLIT_1, SPLIT_3]);
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

    it('computes the reconciled balance and last reconcile date via one SQL aggregate', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue({
            guid: ACCOUNT,
            name: 'Checking',
            account_type: 'BANK',
            commodity: { mnemonic: 'USD' },
        });
        mockQueryRawRouting({
            // 100.00 + 25.50 − 10.00 summed in the database
            reconciledCents: 11550,
            lastReconcileDate: '2026-05-31T00:00:00.000Z',
            candidates: [
                {
                    guid: SPLIT_1,
                    tx_guid: TX_1,
                    memo: 'memo one',
                    reconcile_state: 'c',
                    quantity_num: BigInt(4200),
                    quantity_denom: BigInt(100),
                    post_date: new Date('2026-06-10T00:00:00.000Z'),
                    enter_date: new Date('2026-06-10T08:00:00.000Z'),
                    num: '1042',
                    description: 'Grocery store',
                },
                {
                    guid: SPLIT_2,
                    tx_guid: TX_2,
                    memo: null,
                    reconcile_state: 'n',
                    quantity_num: BigInt(-1550),
                    quantity_denom: BigInt(100),
                    post_date: new Date('2026-06-20T00:00:00.000Z'),
                    enter_date: null,
                    num: null,
                    description: null,
                },
            ],
            sessions: [],
        });

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
                transactionGuid: TX_1,
                date: '2026-06-10T00:00:00.000Z',
                enterDate: '2026-06-10T08:00:00.000Z',
                num: '1042',
                description: 'Grocery store',
                memo: 'memo one',
                amount: 42,
                state: 'c',
            },
            {
                guid: SPLIT_2,
                transactionGuid: TX_2,
                date: '2026-06-20T00:00:00.000Z',
                enterDate: null,
                num: '',
                description: '',
                memo: '',
                amount: -15.5,
                state: 'n',
            },
        ]);
        // The reconciled balance is computed by ONE SQL aggregate over the
        // 'y' splits — never by loading them all into JS.
        const aggregateSql = mockPrisma.$queryRaw.mock.calls
            .map(sqlText)
            .find((sql: string) => sql.includes('SUM('));
        expect(aggregateSql).toContain("reconcile_state = 'y'");
        expect(aggregateSql).toContain('MAX(reconcile_date)');
        expect(mockPrisma.splits.findMany).not.toHaveBeenCalled();
    });

    it('reports null last reconcile date and zero balance for a never-reconciled account', async () => {
        mockPrisma.accounts.findUnique.mockResolvedValue({
            guid: ACCOUNT,
            name: 'Checking',
            account_type: 'BANK',
            commodity: null,
        });
        mockQueryRawRouting({ reconciledCents: null, candidates: [], sessions: [] });

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
    it('rejects with the recomputed difference when it is non-zero', async () => {
        // reconciled 100.00, selected 50.00, ending 175.00 → difference 25.00
        mockFinalize([selectedSplit(SPLIT_1, 5000)], 10000);

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
        mockFinalize([selectedSplit(SPLIT_1, 4999)], 10000);
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 150, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'not_zero', detail: { differenceCents: 1 } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('uses the account SCU exactly for fractional shares instead of cents', async () => {
        mockFinalize([
            { ...selectedSplit(SPLIT_1, 5), quantity_denom: 1000n },
            { ...selectedSplit(SPLIT_2, 5), quantity_denom: 1000n, tx_guid: TX_2 },
        ], 5);
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 2 });

        await expect(finalizeReconciliation(
            ACCOUNT, STATEMENT_DATE, '0.015', [SPLIT_1, SPLIT_2], undefined, undefined, false, 1000,
        )).resolves.toMatchObject({ reconciledSplits: 2 });
    });

    it('permits only the explicit discrepancy escape hatch and records the entered statement balance', async () => {
        mockFinalize([selectedSplit(SPLIT_1, 5000)], 10000);
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.splits.createMany.mockResolvedValue({ count: 2 });
        mockPrisma.accounts.findUnique.mockResolvedValue({ commodity_guid: 'commodity-1', commodity: { mnemonic: 'USD' } });
        mockPrisma.accounts.findFirst.mockResolvedValue({ guid: 'imbalance-account' });
        mockPrisma.books.findUnique.mockResolvedValue({ root_account_guid: 'root-account' });
        mockPrisma.transactions.create.mockResolvedValue({});
        mockPrisma.$executeRaw.mockResolvedValue(0);

        await expect(
            finalizeReconciliation(
                ACCOUNT,
                STATEMENT_DATE,
                175,
                [SPLIT_1],
                undefined,
                { bookGuid: 'book0000000000000000000000000001', userId: 42 },
                true,
            ),
        ).resolves.toMatchObject({ reconciledSplits: 1, endingBalance: 175 });

        expect(mockPrisma.splits.updateMany).toHaveBeenCalledOnce();
        const sessionSql = mockPrisma.$executeRaw.mock.calls.map(sqlText).join('\n');
        expect(sessionSql).toContain("statementEndingBalance");
        expect(sessionSql).toContain('ending_difference');
        expect(mockPrisma.$executeRaw.mock.calls.some((call: unknown[]) => call.includes(175))).toBe(true);
    });

    it('sets exactly the requested splits to y with the statement date', async () => {
        // reconciled 100.00 + selected (42.00 − 15.50) = 126.50 = ending
        mockFinalize(
            [selectedSplit(SPLIT_1, 4200), selectedSplit(SPLIT_2, -1550, { tx_guid: TX_2 })],
            10000,
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
        mockFinalize([selectedSplit(SPLIT_1, 2650)], 10000);
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });

        await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 126.5, [SPLIT_1, SPLIT_1]);
        expect(mockPrisma.splits.updateMany).toHaveBeenCalledWith({
            where: { guid: { in: [SPLIT_1] }, account_guid: ACCOUNT },
            data: { reconcile_state: 'y', reconcile_date: STATEMENT_DATE },
        });
    });

    it('rejects splits that do not exist', async () => {
        mockFinalize([selectedSplit(SPLIT_1, 1000)], null);
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1, SPLIT_3]),
        ).rejects.toMatchObject({ code: 'not_found', detail: { missing: [SPLIT_3] } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits belonging to a different account', async () => {
        mockFinalize(
            [selectedSplit(SPLIT_1, 1000, { account_guid: OTHER_ACCOUNT })],
            null,
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request', detail: { splitGuids: [SPLIT_1] } });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits that are already reconciled', async () => {
        mockFinalize(
            [selectedSplit(SPLIT_1, 1000, { reconcile_state: 'y' })],
            null,
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request' });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splits posted after the statement date', async () => {
        mockFinalize(
            [selectedSplit(SPLIT_1, 1000, { post_date: new Date('2026-07-01T00:00:00.000Z') })],
            null,
        );
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).rejects.toMatchObject({ code: 'bad_request' });
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
    });

    it('allows a split posted on the statement date itself (end of day inclusive)', async () => {
        mockFinalize(
            [selectedSplit(SPLIT_1, 1000, { post_date: new Date('2026-06-30T10:59:00.000Z') })],
            null,
        );
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });
        await expect(
            finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 10, [SPLIT_1]),
        ).resolves.toMatchObject({ reconciledSplits: 1 });
    });

    it('finalizes with zero selected splits when the difference is already zero', async () => {
        mockQueryRawRouting({ reconciledCents: 10000 });
        const result = await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 100, []);
        expect(result.reconciledSplits).toBe(0);
        expect(mockPrisma.splits.updateMany).not.toHaveBeenCalled();
        // No splits selected → no split reads and no row locks at all.
        expect(mockPrisma.splits.findMany).not.toHaveBeenCalled();
        const forUpdateCalls = mockPrisma.$queryRaw.mock.calls
            .map(sqlText)
            .filter((sql: string) => sql.includes('FOR UPDATE'));
        expect(forUpdateCalls).toEqual([]);
    });

    it('records a completed verification and resolves its Action Center item atomically', async () => {
        mockQueryRawRouting({ reconciledCents: null });
        mockPrisma.$executeRaw.mockResolvedValue(1);

        const result = await finalizeReconciliation(
            ACCOUNT,
            STATEMENT_DATE,
            0,
            [],
            undefined,
            {
                bookGuid: 'book0000000000000000000000000001',
                userId: 42,
                sessionId: 'session-1',
                interactionDelta: 3,
            },
        );

        expect(result.reconciledSplits).toBe(0);
        expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
        const executedSql = mockPrisma.$executeRaw.mock.calls
            .map(sqlText)
            .join('\n');
        expect(executedSql).toContain("origin = 'statement_reconciliation'");
        expect(executedSql).toContain("state = 'resolved'");
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('serializes on a per-account advisory lock, then locks parent TRANSACTION rows before the split writes', async () => {
        mockFinalize(
            [selectedSplit(SPLIT_1, 2650, { tx_guid: TX_2 }), selectedSplit(SPLIT_2, 0, { tx_guid: TX_1 })],
            10000,
        );
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 2 });

        await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 126.5, [SPLIT_1, SPLIT_2]);

        const calls = mockPrisma.$queryRaw.mock.calls.map(sqlText);

        // 1) The advisory lock is the FIRST statement of the in-tx work —
        //    it serializes concurrent finalizes on this account and runs
        //    before any reads.
        expect(calls[0]).toContain('pg_advisory_xact_lock');
        expect(mockPrisma.$queryRaw.mock.calls[0][1]).toBe(`reconcile:${ACCOUNT}`);
        expect(mockPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            mockPrisma.splits.findMany.mock.invocationCallOrder[0],
        );

        // 2) Canonical lock order (matches the transaction PUT/DELETE
        //    routes): the parent TRANSACTION rows are locked, ordered by
        //    guid, BEFORE the split write.
        const lockIdx = calls.findIndex((sql: string) => sql.includes('FOR UPDATE'));
        expect(lockIdx).toBeGreaterThanOrEqual(0);
        expect(calls[lockIdx]).toContain('FROM transactions');
        expect(calls[lockIdx]).toContain('ORDER BY guid');
        // Distinct parent tx guids, sorted for a deterministic lock order.
        expect(mockPrisma.$queryRaw.mock.calls[lockIdx][1]).toEqual([TX_1, TX_2]);
        expect(mockPrisma.$queryRaw.mock.invocationCallOrder[lockIdx]).toBeLessThan(
            mockPrisma.splits.updateMany.mock.invocationCallOrder[0],
        );

        // 3) The old whole-account splits lock is gone: nothing FOR UPDATEs
        //    split rows.
        for (const sql of calls) {
            if (sql.includes('FOR UPDATE')) {
                expect(sql).not.toContain('FROM splits');
            }
        }
    });

    it("bumps enter_date on the reconciled splits' parent transactions", async () => {
        mockFinalize([selectedSplit(SPLIT_1, 2650)], 10000);
        mockPrisma.splits.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.$executeRaw.mockResolvedValue(1);

        await finalizeReconciliation(ACCOUNT, STATEMENT_DATE, 126.5, [SPLIT_1]);

        const bumpSql = mockPrisma.$executeRaw.mock.calls
            .map(sqlText)
            .join('\n');
        expect(bumpSql).toContain('SET enter_date = NOW()');
    });

    it('uses an injected transaction client when provided (no new $transaction)', async () => {
        const txClient = {
            splits: {
                findMany: vi.fn(async (args: any) => {
                    if (args?.where?.guid?.in) return [selectedSplit(SPLIT_1, 2500)];
                    throw new Error('Unexpected splits.findMany args');
                }),
                updateMany: vi.fn(async () => ({ count: 1 })),
            },
            $queryRaw: vi.fn(async (template: TemplateStringsArray) => {
                const sql = template.join('?');
                if (sql.includes('SUM(')) return reconciledAggregateRow(10000);
                return [];
            }),
            $executeRaw: vi.fn(async () => 0),
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
