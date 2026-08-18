/**
 * `findOrCreateAccount` called WITHOUT a transaction — the email bill-capture
 * path (src/lib/business/bill-capture.ts) does exactly this.
 *
 * Its serializer is `pg_advisory_xact_lock`, which is released at the end of
 * the transaction. Run on the top-level client there is no transaction, so the
 * lock is released the instant the statement returns and the post-lock re-check
 * races exactly as if the guard were absent — a no-op wearing a guard's name.
 * So this path must open its own transaction; `acquireNamedXactLock` now
 * refuses the alternative outright rather than pretending.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, txMock } = vi.hoisted(() => {
    // The tx client keeps `$transaction` (the real one does) and drops
    // `$connect` — that absence is what identifies it as already being inside
    // a transaction. See book-lock-transaction-scope.test.ts.
    const txMock = {
        accounts: { findFirst: vi.fn(), create: vi.fn() },
        $queryRaw: vi.fn(async () => [{ locked: null }]),
        $transaction: vi.fn(),
    };
    return {
        txMock,
        prismaMock: {
            accounts: { findFirst: vi.fn(), create: vi.fn() },
            $queryRaw: vi.fn(async () => [{ locked: null }]),
            $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txMock)),
            $connect: vi.fn(),
            $disconnect: vi.fn(),
        },
    };
});

vi.mock('../prisma', () => ({ default: prismaMock }));

import { findOrCreateAccount } from '../gnucash';
import { AdvisoryLockOutsideTransactionError } from '../book-lock';

beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txMock));
    txMock.accounts.findFirst.mockResolvedValue(null);
    txMock.accounts.create.mockResolvedValue({});
});

describe('findOrCreateAccount without a caller-supplied transaction', () => {
    it('opens its own transaction so the advisory lock actually holds', async () => {
        await findOrCreateAccount('Expenses:Uncategorized', 'root', 'usd');

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        // Every read, lock and write went to the transaction client...
        expect(txMock.accounts.create).toHaveBeenCalledTimes(2);
        expect(txMock.$queryRaw).toHaveBeenCalledTimes(2);
        // ...and none leaked onto the top-level client, where the lock would
        // have been released before its own re-check.
        expect(prismaMock.accounts.create).not.toHaveBeenCalled();
        expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('locks on (parent, segment) and re-checks under the lock before creating', async () => {
        const order: string[] = [];
        txMock.$queryRaw.mockImplementation(async () => { order.push('lock'); return [{ locked: null }]; });
        txMock.accounts.findFirst.mockImplementation(async () => { order.push('find'); return null; });
        txMock.accounts.create.mockImplementation(async () => { order.push('create'); return {}; });

        await findOrCreateAccount('Expenses', 'root', 'usd');

        expect(order).toEqual(['find', 'lock', 'find', 'create']);
    });

    it("uses the caller's transaction when given one, without nesting", async () => {
        await findOrCreateAccount('Expenses', 'root', 'usd', txMock as never);

        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(txMock.accounts.create).toHaveBeenCalledTimes(1);
    });

    it('cannot be made to run the lock outside a transaction', async () => {
        // Handing it the top-level client explicitly is the same hazard as
        // handing it nothing, and is wrapped the same way — there is no
        // argument that reaches the unguarded path.
        await findOrCreateAccount('Expenses', 'root', 'usd', prismaMock as never);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);

        // And if something ever did, the helper refuses rather than no-op.
        const { acquireNamedXactLock } = await import('../book-lock');
        // A non-account key, because account keys are refused by namespace
        // before the transaction-scope check is even reached — see
        // book-lock-transaction-scope.test.ts.
        await expect(acquireNamedXactLock(prismaMock as never, 'commodity:CURRENCY:USD'))
            .rejects.toBeInstanceOf(AdvisoryLockOutsideTransactionError);
    });
});
