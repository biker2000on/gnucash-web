/**
 * Reconciled-split guard tests.
 *
 * The guard is the single enforcement point every ledger-mutating path uses,
 * so its rules are pinned here: 'y' and 'f' are protected, 'n' and 'c' are
 * not, the message names the offending split, and the HTTP shape is 423 with
 * code RECONCILED_SPLIT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
    default: { splits: { findMany: findManyMock } },
}));

import {
    PROTECTED_RECONCILE_STATES,
    ReconciledSplitError,
    assertNoReconciledSplits,
    assertSplitsNotProtected,
    describeProtectedSplits,
    findProtectedSplits,
    isProtectedReconcileState,
    reconciledSplitResponse,
    withReconciledSplitCheck,
    type SplitReconcileRow,
} from '../reconciled-split.service';

const SPLIT_A = 'a'.repeat(32);
const SPLIT_B = 'b'.repeat(32);
const TX_GUID = 't'.repeat(32);
const ACCOUNT_GUID = 'c'.repeat(32);

function row(overrides: Partial<SplitReconcileRow> = {}): SplitReconcileRow {
    return {
        guid: SPLIT_A,
        tx_guid: TX_GUID,
        account_guid: ACCOUNT_GUID,
        reconcile_state: 'n',
        account: { name: 'Assets:Checking' },
        ...overrides,
    };
}

beforeEach(() => {
    findManyMock.mockReset();
});

describe('isProtectedReconcileState', () => {
    it('protects reconciled and frozen splits', () => {
        expect(PROTECTED_RECONCILE_STATES).toEqual(['y', 'f']);
        expect(isProtectedReconcileState('y')).toBe(true);
        expect(isProtectedReconcileState('f')).toBe(true);
    });

    it('leaves not-reconciled and cleared splits editable', () => {
        expect(isProtectedReconcileState('n')).toBe(false);
        expect(isProtectedReconcileState('c')).toBe(false);
        expect(isProtectedReconcileState(null)).toBe(false);
        expect(isProtectedReconcileState(undefined)).toBe(false);
    });
});

describe('findProtectedSplits', () => {
    it('returns only the protected rows, with their identifying details', () => {
        const refs = findProtectedSplits([
            row({ guid: SPLIT_A, reconcile_state: 'y' }),
            row({ guid: SPLIT_B, reconcile_state: 'n' }),
        ]);
        expect(refs).toEqual([{
            splitGuid: SPLIT_A,
            txGuid: TX_GUID,
            accountGuid: ACCOUNT_GUID,
            accountName: 'Assets:Checking',
            reconcileState: 'y',
        }]);
    });

    it('falls back to the account guid when no account name was joined', () => {
        const refs = findProtectedSplits([
            row({ reconcile_state: 'f', account: undefined }),
        ]);
        expect(refs[0].accountName).toBeNull();
        expect(describeProtectedSplits(refs)).toContain(ACCOUNT_GUID);
    });

    it('elides past five offenders instead of dumping the whole batch', () => {
        const refs = findProtectedSplits(
            Array.from({ length: 7 }, (_, i) =>
                row({ guid: `${i}`.repeat(32), reconcile_state: 'y' })),
        );
        expect(describeProtectedSplits(refs)).toContain('and 2 more');
    });
});

describe('assertSplitsNotProtected', () => {
    it.each([['y'], ['f']])('throws for a %s split, naming it and the way out', state => {
        let thrown: unknown;
        try {
            assertSplitsNotProtected('delete this transaction', [
                row({ reconcile_state: state }),
            ]);
        } catch (err) {
            thrown = err;
        }

        expect(thrown).toBeInstanceOf(ReconciledSplitError);
        const error = thrown as ReconciledSplitError;
        expect(error.code).toBe('RECONCILED_SPLIT');
        expect(error.message).toContain('Cannot delete this transaction');
        expect(error.message).toContain(SPLIT_A);
        expect(error.message).toContain('Assets:Checking');
        expect(error.message).toContain(`reconcile_state '${state}'`);
        // Names the escape hatch so the caller knows what to do next.
        expect(error.message).toMatch(/unreconcile/i);
        expect(error.splits).toHaveLength(1);
    });

    it.each([['n'], ['c']])('allows a %s split through untouched', state => {
        expect(() =>
            assertSplitsNotProtected('edit this transaction', [row({ reconcile_state: state })]),
        ).not.toThrow();
    });

    it('reports every offender in one error', () => {
        try {
            assertSplitsNotProtected('edit this transaction', [
                row({ guid: SPLIT_A, reconcile_state: 'y' }),
                row({ guid: SPLIT_B, reconcile_state: 'f' }),
            ]);
            expect.unreachable('guard should have thrown');
        } catch (err) {
            expect((err as ReconciledSplitError).splits.map(s => s.splitGuid))
                .toEqual([SPLIT_A, SPLIT_B]);
        }
    });
});

describe('assertNoReconciledSplits', () => {
    it('queries only for protected states and throws on a hit', async () => {
        findManyMock.mockResolvedValue([row({ reconcile_state: 'y' })]);

        await expect(
            assertNoReconciledSplits('edit this transaction', { txGuids: [TX_GUID] }),
        ).rejects.toBeInstanceOf(ReconciledSplitError);

        expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                OR: [{ tx_guid: { in: [TX_GUID] } }],
                reconcile_state: { in: ['y', 'f'] },
            },
        }));
    });

    it('passes when the lookup finds nothing protected', async () => {
        findManyMock.mockResolvedValue([]);
        await expect(
            assertNoReconciledSplits('edit this transaction', { splitGuids: [SPLIT_A] }),
        ).resolves.toBeUndefined();
    });

    it('skips the query entirely when there is nothing to check', async () => {
        await expect(
            assertNoReconciledSplits('edit this transaction', {}),
        ).resolves.toBeUndefined();
        expect(findManyMock).not.toHaveBeenCalled();
    });

    it('runs on the caller-supplied transaction client, not the global pool', async () => {
        const clientFindMany = vi.fn().mockResolvedValue([]);
        await assertNoReconciledSplits(
            'edit this transaction',
            { txGuids: [TX_GUID] },
            // The guard only needs splits.findMany; the narrow stub proves it
            // never reaches for the global client mid-transaction.
            { client: { splits: { findMany: clientFindMany } } as never },
        );
        expect(clientFindMany).toHaveBeenCalledTimes(1);
        expect(findManyMock).not.toHaveBeenCalled();
    });
});

describe('reconciledSplitResponse', () => {
    it('is 423 Locked with the code, message, and offending splits', async () => {
        const error = new ReconciledSplitError('edit this transaction', [{
            splitGuid: SPLIT_A,
            txGuid: TX_GUID,
            accountGuid: ACCOUNT_GUID,
            accountName: 'Assets:Checking',
            reconcileState: 'y',
        }]);

        const response = reconciledSplitResponse(error);
        const body = await response.json();

        // 423, deliberately NOT 409: the transaction clients treat 409 as an
        // optimistic-lock conflict and silently reload+retry.
        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_A);
        expect(body.splits).toEqual([{
            guid: SPLIT_A,
            tx_guid: TX_GUID,
            account_guid: ACCOUNT_GUID,
            reconcile_state: 'y',
        }]);
    });
});

describe('withReconciledSplitCheck', () => {
    it('returns null when the mutation may proceed', async () => {
        findManyMock.mockResolvedValue([]);
        await expect(
            withReconciledSplitCheck('edit this transaction', { txGuids: [TX_GUID] }),
        ).resolves.toBeNull();
    });

    it('returns the ready 423 response when blocked', async () => {
        findManyMock.mockResolvedValue([row({ reconcile_state: 'f' })]);
        const response = await withReconciledSplitCheck(
            'edit this transaction', { txGuids: [TX_GUID] },
        );
        expect(response?.status).toBe(423);
    });

    it('rethrows unrelated failures instead of masking them as a block', async () => {
        findManyMock.mockRejectedValue(new Error('connection reset'));
        await expect(
            withReconciledSplitCheck('edit this transaction', { txGuids: [TX_GUID] }),
        ).rejects.toThrow('connection reset');
    });
});
