import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import {
    withPeriodLockCheck,
    assertNotLocked,
    PeriodLockedError,
    periodLockedResponse,
} from '@/lib/services/period-lock.service';
import {
    assertSplitsNotProtected,
    lockTransactionsForUpdate,
    PROTECTED_RECONCILE_STATES,
    ReconciledSplitError,
    reconciledSplitResponse,
} from '@/lib/services/reconciled-split.service';

/**
 * A guid in the request does not belong to the caller's book.
 *
 * Raised from inside the database transaction so the whole move rolls back
 * (nothing is ever partially moved), and mapped to a 404 by the handler's
 * catch. 404 — not 403 — is deliberate and matches the sibling bulk routes:
 * a distinct "exists but is not yours" status would turn this endpoint into
 * a cross-book guid-existence oracle.
 */
class OutOfBookError extends Error {
    readonly code = 'OUT_OF_BOOK';

    constructor(message: string) {
        super(message);
        this.name = 'OutOfBookError';
    }
}

/** The single 404 body used for every out-of-book split, in or out of the tx. */
const SPLITS_NOT_IN_BOOK = 'Some splits not found in this book';

/**
 * @openapi
 * /api/splits/bulk/move:
 *   post:
 *     description: Bulk move splits from one account to another.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - splitGuids
 *               - targetAccountGuid
 *             properties:
 *               splitGuids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of split GUIDs to move
 *               targetAccountGuid:
 *                 type: string
 *                 description: Target account GUID to move splits to
 *     responses:
 *       200:
 *         description: Splits moved successfully.
 *       400:
 *         description: Invalid request or currency mismatch.
 *       404:
 *         description: Target account or splits not found in the caller's book.
 *       500:
 *         description: Server error.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const { splitGuids, targetAccountGuid } = body;

        // Validation
        if (!splitGuids || !Array.isArray(splitGuids) || splitGuids.length === 0) {
            return NextResponse.json(
                { error: 'splitGuids array is required' },
                { status: 400 }
            );
        }
        if (!targetAccountGuid || typeof targetAccountGuid !== 'string') {
            return NextResponse.json(
                { error: 'targetAccountGuid is required' },
                { status: 400 }
            );
        }

        // A repeated guid in the body is the same split asked for twice, not
        // two rows: dedupe before every count comparison below, otherwise a
        // duplicate produces a spurious "not found"/"reconciled" mismatch.
        const uniqueSplitGuids: string[] = [...new Set<string>(splitGuids)];

        // BOOK SCOPING. Both ends of this move — the target account and the
        // account every split currently posts to — must live in the caller's
        // book. Resolved by guid alone, an `edit` user on book A could re-book
        // book B's splits into their own account (or push their own splits
        // into book B), corrupting the balances of both ledgers.
        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
        if (bookAccountGuids.length === 0) {
            // Explicit, not incidental: an empty list must fail closed here
            // rather than resting on Prisma rendering `in: []` as an
            // always-false predicate — that is an ORM implementation detail,
            // not something a security guarantee may depend on.
            return NextResponse.json(
                { error: 'Target account not found in this book' },
                { status: 404 }
            );
        }

        // Verify target account exists IN THIS BOOK. `equals` and `in` on one
        // filter compose as a conjunction — both must hold — so an
        // out-of-book account is indistinguishable from a nonexistent one.
        // (The engine is free to optimise the emitted SQL; it is the AND
        // semantics that are guaranteed, not a particular statement shape.)
        const targetAccount = await prisma.accounts.findFirst({
            where: { guid: { equals: targetAccountGuid, in: bookAccountGuids } },
            select: { guid: true, commodity_guid: true },
        });
        if (!targetAccount) {
            return NextResponse.json(
                { error: 'Target account not found in this book' },
                { status: 404 }
            );
        }

        // Verify all splits exist IN THIS BOOK and have the same
        // commodity_guid as target. Out-of-book splits simply do not come
        // back, so the count check below rejects the whole batch atomically —
        // no partial move, and no oracle telling the caller whether the guid
        // exists in someone else's book.
        const splits = await prisma.splits.findMany({
            where: {
                guid: { in: uniqueSplitGuids },
                account_guid: { in: bookAccountGuids },
            },
            include: {
                account: { select: { commodity_guid: true, name: true } },
                transaction: { select: { post_date: true } },
            },
        });

        if (splits.length !== uniqueSplitGuids.length) {
            return NextResponse.json(
                { error: SPLITS_NOT_IN_BOOK },
                { status: 404 }
            );
        }

        const incompatible = splits.filter(
            s => s.account?.commodity_guid !== targetAccount.commodity_guid
        );
        if (incompatible.length > 0) {
            return NextResponse.json(
                { error: 'Cannot move splits across different currencies' },
                { status: 400 }
            );
        }

        // Reconciled/frozen splits are agreed against a bank statement;
        // re-booking one to another account silently breaks that agreement.
        // Fast-fail here, re-checked authoritatively inside the transaction.
        assertSplitsNotProtected('move these splits to another account', splits);

        // Period lock pre-check: moving a split re-books it to another
        // account, so every affected transaction must be after the lock date.
        // (Fast-fail only — the authoritative check runs inside the DB
        // transaction below with the cache bypassed.)
        const lockError = await withPeriodLockCheck(
            roleResult.bookGuid,
            splits.map(s => s.transaction?.post_date),
        );
        if (lockError) return lockError;

        // Perform the bulk update atomically with the authoritative period
        // lock check and an enter_date bump on every parent transaction (so
        // concurrent editors' optimistic locks invalidate).
        const result = await prisma.$transaction(async (tx) => {
            // Canonical lock order (same as the transaction PUT/DELETE
            // routes): lock the parent TRANSACTION rows FIRST, ordered by
            // guid, then read and write the splits. Two reasons the lock has
            // to come before the read, not just before the write:
            //   1. a concurrent transaction save also locks its transactions
            //      row before touching splits, so the reverse order would
            //      ABBA-deadlock;
            //   2. READ COMMITTED takes no locks on a plain SELECT, so a
            //      reconcile committing between an unlocked read and our
            //      write would sail past the guard below.
            // A split's tx_guid never changes, so deriving the lock set from
            // the pre-transaction read is safe even though the rest of that
            // snapshot is treated as stale.
            const parentTxGuids = [...new Set(splits.map(s => s.tx_guid))].sort();
            await lockTransactionsForUpdate(parentTxGuids, tx);

            const freshSplits = await tx.splits.findMany({
                where: {
                    guid: { in: uniqueSplitGuids },
                    account_guid: { in: bookAccountGuids },
                },
                select: {
                    guid: true,
                    tx_guid: true,
                    account_guid: true,
                    reconcile_state: true,
                    account: { select: { name: true } },
                    transaction: { select: { post_date: true } },
                },
            });
            // Authoritative book check: the read above is book-scoped, so a
            // split that left this book between the pre-check and the lock
            // simply does not come back. Refuse the whole batch — the
            // transaction rolls back, so nothing moved.
            if (freshSplits.length !== uniqueSplitGuids.length) {
                throw new OutOfBookError(SPLITS_NOT_IN_BOOK);
            }
            // Authoritative check: read under the parent lock, so a
            // concurrent reconcile cannot slip between it and the write.
            assertSplitsNotProtected('move these splits to another account', freshSplits);
            await assertNotLocked(
                roleResult.bookGuid,
                freshSplits.map(s => s.transaction?.post_date),
                { bypassCache: true, client: tx },
            );

            // Belt and braces: the protected states AND the book scope are
            // also in the WHERE clause, so the write can never land on a
            // reconciled row, nor on another book's row, even if a future
            // caller reaches this code without the lock or the pre-checks.
            const moved = await tx.splits.updateMany({
                where: {
                    guid: { in: uniqueSplitGuids },
                    account_guid: { in: bookAccountGuids },
                    reconcile_state: { notIn: [...PROTECTED_RECONCILE_STATES] },
                },
                data: { account_guid: targetAccountGuid },
            });
            if (moved.count !== uniqueSplitGuids.length) {
                // Fewer rows moved than asked for while holding the lock. Two
                // predicates can exclude a row — the book scope or the
                // reconcile state — and the ORDER in which they are diagnosed
                // is a security property, not a style choice.
                //
                // The book scope MUST be ruled out first. The 423 message
                // names the offending split's ACCOUNT, so diagnosing the
                // reconcile state first would, for a split that left this book
                // after the reads above, hand the caller the name of an
                // account in someone else's book. `assertNoReconciledSplits`
                // cannot be used here for exactly that reason: it re-reads by
                // guid with no account scope. (Giving it an account-scope
                // parameter is filed separately as
                // `reconciled-split-service-account-scope`.)
                //
                // No new lock is needed: the parent transaction rows were
                // locked FOR UPDATE at the top of this transaction, a split's
                // tx_guid never changes, so this read is still a
                // read-after-lock and nothing can commit under it.
                const diagnostic = await tx.splits.findMany({
                    where: {
                        guid: { in: uniqueSplitGuids },
                        account_guid: { in: bookAccountGuids },
                    },
                    select: {
                        guid: true,
                        tx_guid: true,
                        account_guid: true,
                        reconcile_state: true,
                        account: { select: { name: true } },
                    },
                });
                if (diagnostic.length !== uniqueSplitGuids.length) {
                    // A requested split is not in this book. Indistinguishable
                    // from not-found, and no foreign account is named.
                    throw new OutOfBookError(SPLITS_NOT_IN_BOOK);
                }
                // Every requested split IS in this book, so naming one is
                // safe — and useful: this is the actionable 423 telling the
                // caller which split to unreconcile.
                assertSplitsNotProtected('move these splits to another account', diagnostic);
                // Neither predicate explains the short count (the row was
                // deleted underneath us, say). Refuse rather than report a
                // quietly short "updated"; the transaction rolls back.
                throw new OutOfBookError(SPLITS_NOT_IN_BOOK);
            }

            if (parentTxGuids.length > 0) {
                await tx.transactions.updateMany({
                    where: { guid: { in: parentTxGuids } },
                    data: { enter_date: new Date() },
                });
            }

            return moved;
        });

        // Invalidate dashboard metric caches from the earliest affected
        // transaction date (moving splits changes account-scoped metrics)
        try {
            const postDates = splits
                .map(s => s.transaction?.post_date)
                .filter((d): d is Date => d != null);
            if (postDates.length > 0) {
                const earliest = postDates.reduce((a, b) => (a < b ? a : b));
                await cacheInvalidateFrom(roleResult.bookGuid, earliest);
            }
        } catch (err) {
            // Cache invalidation failure should not break the move operation
            console.warn('Cache invalidation failed:', err);
        }

        void publishDataChange(roleResult.bookGuid, 'transactions', { action: 'bulk' });

        return NextResponse.json({
            success: true,
            updated: result.count,
        });
    } catch (error) {
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        if (error instanceof ReconciledSplitError) {
            return reconciledSplitResponse(error);
        }
        if (error instanceof OutOfBookError) {
            return NextResponse.json(
                { error: error.message },
                { status: 404 }
            );
        }
        console.error('Failed to bulk move splits:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
