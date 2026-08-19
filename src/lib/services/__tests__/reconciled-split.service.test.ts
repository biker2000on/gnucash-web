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
/**
 * Reconciled-split guard tests.
 *
 * The guard is the single enforcement point every ledger-mutating path uses,
 * so its rules are pinned here: 'y' and 'f' are protected, 'n' and 'c' are
 * not, the message names the offending split, and the HTTP shape is 423 with
 * code RECONCILED_SPLIT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock, queryRawMock } = vi.hoisted(() => ({
    findManyMock: vi.fn(),
    queryRawMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    default: { splits: { findMany: findManyMock }, $queryRaw: queryRawMock },
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
/** The caller's book scope. Required by the guard on every call. */
const BOOK = [ACCOUNT_GUID, 'd'.repeat(32)];

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
    queryRawMock.mockReset();
    queryRawMock.mockResolvedValue([]);
});

/** SQL text of a tagged-template $queryRaw call. */
function sqlText(call: unknown[]): string {
    return (call[0] as TemplateStringsArray).join('?');
}

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
    /**
     * The transaction client is REQUIRED (it is not an optional convenience):
     * without it the FOR UPDATE would run as its own implicit transaction and
     * release before the caller's write, so the "race-free" contract would be
     * a lie. These tests drive the guard through an explicit client stub, the
     * way every production call site does.
     */
    function txClient() {
        return { splits: { findMany: findManyMock }, $queryRaw: queryRawMock } as never;
    }

    it('queries only for protected states and throws on a hit', async () => {
        findManyMock.mockResolvedValue([row({ reconcile_state: 'y' })]);

        await expect(
            assertNoReconciledSplits('edit this transaction', { txGuids: [TX_GUID] }, { client: txClient(), bookAccountGuids: BOOK }),
        ).rejects.toBeInstanceOf(ReconciledSplitError);

        expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                OR: [{ tx_guid: { in: [TX_GUID] } }],
                account_guid: { in: BOOK },
                reconcile_state: { in: ['y', 'f'] },
            },
        }));
    });

    it('passes when the lookup finds nothing protected', async () => {
        findManyMock.mockResolvedValue([]);
        await expect(
            assertNoReconciledSplits('edit this transaction', { splitGuids: [SPLIT_A] }, { client: txClient(), bookAccountGuids: BOOK }),
        ).resolves.toBeUndefined();
    });

    it('skips the query entirely when there is nothing to check', async () => {
        await expect(
            assertNoReconciledSplits('edit this transaction', {}, { client: txClient(), bookAccountGuids: BOOK }),
        ).resolves.toBeUndefined();
        expect(findManyMock).not.toHaveBeenCalled();
        expect(queryRawMock).not.toHaveBeenCalled();
    });

    it('runs only on the supplied transaction client, never the global pool', async () => {
        const clientFindMany = vi.fn().mockResolvedValue([]);
        const clientQueryRaw = vi.fn().mockResolvedValue([]);
        await assertNoReconciledSplits(
            'edit this transaction',
            { txGuids: [TX_GUID] },
            {
                client: { splits: { findMany: clientFindMany }, $queryRaw: clientQueryRaw } as never,
                bookAccountGuids: BOOK,
            },
        );
        expect(clientFindMany).toHaveBeenCalledTimes(1);
        expect(clientQueryRaw).toHaveBeenCalledTimes(1);
        // Reaching for the global client mid-transaction would take a second
        // pool connection AND read outside the transaction's snapshot.
        expect(findManyMock).not.toHaveBeenCalled();
    });

    it('locks the parent transactions FOR UPDATE before reading the splits', async () => {
        findManyMock.mockResolvedValue([]);
        await assertNoReconciledSplits('edit this transaction', { txGuids: [TX_GUID] }, { client: txClient(), bookAccountGuids: BOOK });

        expect(queryRawMock).toHaveBeenCalledTimes(1);
        const sql = sqlText(queryRawMock.mock.calls[0]);
        expect(sql).toContain('FROM transactions');
        expect(sql).toContain('FOR UPDATE');
        expect(sql).toContain('ORDER BY');
        // Lock strictly BEFORE the read — the whole point.
        expect(queryRawMock.mock.invocationCallOrder[0])
            .toBeLessThan(findManyMock.mock.invocationCallOrder[0]);
    });

    it('resolves AND locks parents in one statement when addressing splits by guid', async () => {
        findManyMock.mockResolvedValue([]);
        await assertNoReconciledSplits('move these splits', { splitGuids: [SPLIT_A] }, { client: txClient(), bookAccountGuids: BOOK });

        // A separate "read the tx_guids, then lock them" pair would be safe
        // only by the tx_guid-immutability argument; folding the resolution
        // into the locking statement removes the caveat entirely.
        const sql = sqlText(queryRawMock.mock.calls[0]);
        expect(sql).toContain('FROM transactions');
        expect(sql).toContain('FROM splits');
        expect(sql).toContain('FOR UPDATE');
        expect(queryRawMock.mock.calls[0][1]).toEqual([SPLIT_A]);
        // No unlocked parent lookup happened before the lock.
        expect(queryRawMock.mock.invocationCallOrder[0])
            .toBeLessThan(findManyMock.mock.invocationCallOrder[0]);
    });

    it('deduplicates and sorts the lock set so concurrent writers cannot ABBA-deadlock', async () => {
        findManyMock.mockResolvedValue([]);
        await assertNoReconciledSplits('edit these transactions', {
            txGuids: ['t2'.padEnd(32, '0'), 't1'.padEnd(32, '0'), 't2'.padEnd(32, '0')],
        }, { client: txClient(), bookAccountGuids: BOOK });
        expect(queryRawMock.mock.calls[0][1]).toEqual(['t1'.padEnd(32, '0'), 't2'.padEnd(32, '0')]);
    });

    /**
     * BOOK SCOPE.
     *
     * The guids reach this guard straight from the request body. Without a
     * book predicate an out-of-book guid would (a) take a FOR UPDATE row lock
     * on another tenant's transaction and (b) come back from the read with its
     * account joined, so the 423 message would name an account the caller
     * cannot see. Both leaks are closed by the same `bookAccountGuids` scope,
     * which is pushed into the lock statements AND the read.
     */
    describe('book scope', () => {
        const OUT_OF_BOOK_SPLIT = 'e'.repeat(32);
        const OUT_OF_BOOK_TX = 'f'.repeat(32);

        it('pushes the book scope into the parent-transaction lock', async () => {
            findManyMock.mockResolvedValue([]);
            await assertNoReconciledSplits(
                'edit this transaction',
                { txGuids: [OUT_OF_BOOK_TX] },
                { client: txClient(), bookAccountGuids: BOOK },
            );
            const sql = sqlText(queryRawMock.mock.calls[0]);
            expect(sql).toContain('FOR UPDATE');
            expect(sql).toContain('s.account_guid = ANY(');
            // The book guid list is bound as the second template value, so a
            // transaction with no split in this book matches no row and is
            // therefore never locked.
            expect(queryRawMock.mock.calls[0][2]).toEqual(BOOK);
        });

        it('pushes the book scope into the split-addressed lock', async () => {
            findManyMock.mockResolvedValue([]);
            await assertNoReconciledSplits(
                'move these splits',
                { splitGuids: [OUT_OF_BOOK_SPLIT] },
                { client: txClient(), bookAccountGuids: BOOK },
            );
            const sql = sqlText(queryRawMock.mock.calls[0]);
            expect(sql).toContain('FOR UPDATE');
            expect(sql).toContain('s.account_guid = ANY(');
            expect(queryRawMock.mock.calls[0][1]).toEqual([OUT_OF_BOOK_SPLIT]);
            expect(queryRawMock.mock.calls[0][2]).toEqual(BOOK);
        });

        it('never names an out-of-book account, because the read is scoped too', async () => {
            // The database applies the account_guid predicate, so a reconciled
            // split in another book simply is not returned: the guard passes
            // and the caller's own book-scoped WHERE refuses the write.
            findManyMock.mockImplementation(async (args: {
                where: { account_guid?: { in: string[] } };
            }) => {
                const scope = args.where.account_guid?.in ?? [];
                const foreign = row({
                    guid: OUT_OF_BOOK_SPLIT,
                    account_guid: 'z'.repeat(32),
                    account: { name: 'OtherBook:Secret Account' },
                    reconcile_state: 'y',
                });
                return scope.includes(foreign.account_guid!) ? [foreign] : [];
            });

            await expect(assertNoReconciledSplits(
                'move these splits',
                { splitGuids: [OUT_OF_BOOK_SPLIT] },
                { client: txClient(), bookAccountGuids: BOOK },
            )).resolves.toBeUndefined();

            expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ account_guid: { in: BOOK } }),
            }));
        });

        it('refuses an empty book scope instead of silently protecting nothing', async () => {
            await expect(assertNoReconciledSplits(
                'edit this transaction',
                { txGuids: [TX_GUID] },
                { client: txClient(), bookAccountGuids: [] },
            )).rejects.toThrow(/book account scope/i);
            expect(queryRawMock).not.toHaveBeenCalled();
            expect(findManyMock).not.toHaveBeenCalled();
        });

        it('refuses an empty book scope even when there is nothing to check', async () => {
            // Loud misuse: a caller that resolved no book is broken whether or
            // not this particular call had targets.
            await expect(assertNoReconciledSplits(
                'edit this transaction', {}, { client: txClient(), bookAccountGuids: [] },
            )).rejects.toThrow(/book account scope/i);
        });
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
    function txClient() {
        return { splits: { findMany: findManyMock }, $queryRaw: queryRawMock } as never;
    }

    it('returns null when the mutation may proceed', async () => {
        findManyMock.mockResolvedValue([]);
        await expect(
            withReconciledSplitCheck('edit this transaction', { txGuids: [TX_GUID] }, { client: txClient(), bookAccountGuids: BOOK }),
        ).resolves.toBeNull();
    });

    it('returns the ready 423 response when blocked', async () => {
        findManyMock.mockResolvedValue([row({ reconcile_state: 'f' })]);
        const response = await withReconciledSplitCheck(
            'edit this transaction', { txGuids: [TX_GUID] }, { client: txClient(), bookAccountGuids: BOOK },
        );
        expect(response?.status).toBe(423);
    });

    it('rethrows unrelated failures instead of masking them as a block', async () => {
        findManyMock.mockRejectedValue(new Error('connection reset'));
        await expect(
            withReconciledSplitCheck('edit this transaction', { txGuids: [TX_GUID] }, { client: txClient(), bookAccountGuids: BOOK }),
        ).rejects.toThrow('connection reset');
    });
});
