/**
 * TransactionService reconciled/frozen split guard.
 *
 * The service used to carry its own inline `reconcile_state === 'y'` check.
 * It now delegates to the shared guard, so 'f' (frozen) is covered too and the
 * error is the same ReconciledSplitError the API routes map to 423.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    prismaMock,
    assertAccountNotLockedMock,
    recordImpliedPricesMock,
    generateGuidMock,
} = vi.hoisted(() => ({
    prismaMock: {
        transactions: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
        splits: { createMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
        $transaction: vi.fn(),
        // Parent-transaction FOR UPDATE lock taken by the shared guard.
        $queryRaw: vi.fn(),
    },
    assertAccountNotLockedMock: vi.fn(),
    recordImpliedPricesMock: vi.fn(),
    generateGuidMock: vi.fn(() => 'g'.repeat(32)),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/gnucash', () => ({
    generateGuid: generateGuidMock,
    toDecimal: vi.fn(() => '0.00'),
}));
vi.mock('@/lib/services/implied-price.service', () => ({
    recordImpliedPrices: recordImpliedPricesMock,
}));
vi.mock('@/lib/services/period-lock.service', () => ({
    assertAccountNotLocked: assertAccountNotLockedMock,
}));

import { TransactionService } from '../transaction.service';
import { ReconciledSplitError } from '../reconciled-split.service';

const TX_GUID = 't'.repeat(32);
const ACCOUNT_A = 'a'.repeat(32);
const ACCOUNT_B = 'b'.repeat(32);
const CURRENCY = 'c'.repeat(32);
const SPLIT_1 = 's1'.padEnd(32, '0');

const updateInput = {
    guid: TX_GUID,
    currency_guid: CURRENCY,
    post_date: new Date('2026-07-15T00:00:00.000Z'),
    description: 'Edited',
    num: '',
    splits: [
        {
            account_guid: ACCOUNT_A, value_num: 100, value_denom: 100,
            memo: '', action: '', reconcile_state: 'n' as const,
        },
        {
            account_guid: ACCOUNT_B, value_num: -100, value_denom: 100,
            memo: '', action: '', reconcile_state: 'n' as const,
        },
    ],
};

function existing(reconcileState: string) {
    return {
        guid: TX_GUID,
        post_date: new Date('2026-07-15T00:00:00.000Z'),
        splits: [
            { guid: SPLIT_1, tx_guid: TX_GUID, account_guid: ACCOUNT_A, reconcile_state: reconcileState },
            { guid: 's2'.padEnd(32, '0'), tx_guid: TX_GUID, account_guid: ACCOUNT_B, reconcile_state: 'n' },
        ],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    assertAccountNotLockedMock.mockResolvedValue(undefined);
    recordImpliedPricesMock.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(
        async (cb: (tx: unknown) => unknown) => cb(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    // Authoritative in-transaction re-read: nothing protected by default.
    prismaMock.splits.findMany.mockResolvedValue([]);
    prismaMock.splits.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.splits.createMany.mockResolvedValue({ count: 2 });
    prismaMock.transactions.update.mockResolvedValue({});
    prismaMock.transactions.delete.mockResolvedValue({});
});

describe('TransactionService.update', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('rejects a %s split without writing', async (_label, state) => {
        prismaMock.transactions.findUnique.mockResolvedValue(existing(state));

        await expect(TransactionService.update(updateInput))
            .rejects.toBeInstanceOf(ReconciledSplitError);
        await TransactionService.update(updateInput).catch((err: ReconciledSplitError) => {
            expect(err.message).toContain(SPLIT_1);
            expect(err.message).toMatch(/edit this transaction/i);
        });

        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still updates when the splits are %s', async (_label, state) => {
        prismaMock.transactions.findUnique.mockResolvedValue(existing(state));

        await TransactionService.update(updateInput);

        expect(prismaMock.splits.deleteMany).toHaveBeenCalledWith({ where: { tx_guid: TX_GUID } });
        expect(prismaMock.splits.createMany).toHaveBeenCalled();
    });
});

describe('TransactionService.delete', () => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('rejects deleting a transaction with a %s split', async (_label, state) => {
        prismaMock.transactions.findUnique.mockResolvedValue(existing(state));

        await expect(TransactionService.delete(TX_GUID))
            .rejects.toBeInstanceOf(ReconciledSplitError);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it.each([
        ['not reconciled', 'n'],
        ['cleared', 'c'],
    ])('still deletes when the splits are %s', async (_label, state) => {
        prismaMock.transactions.findUnique.mockResolvedValue(existing(state));

        await expect(TransactionService.delete(TX_GUID)).resolves.toEqual({
            success: true, guid: TX_GUID,
        });
        expect(prismaMock.transactions.delete).toHaveBeenCalledWith({ where: { guid: TX_GUID } });
    });
});
