import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import {
    withPeriodLockCheck,
    assertNotLocked,
    PeriodLockedError,
    periodLockedResponse,
} from '@/lib/services/period-lock.service';
import {
    assertNoReconciledSplits,
    assertSplitsNotProtected,
    lockTransactionsForUpdate,
    PROTECTED_RECONCILE_STATES,
    ReconciledSplitError,
    reconciledSplitResponse,
} from '@/lib/services/reconciled-split.service';

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
 *         description: Target account or splits not found.
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

        // Verify target account exists
        const targetAccount = await prisma.accounts.findUnique({
            where: { guid: targetAccountGuid },
            select: { guid: true, commodity_guid: true },
        });
        if (!targetAccount) {
            return NextResponse.json(
                { error: 'Target account not found' },
                { status: 404 }
            );
        }

        // Verify all splits exist and have the same commodity_guid as target
        const splits = await prisma.splits.findMany({
            where: { guid: { in: splitGuids } },
            include: {
                account: { select: { commodity_guid: true, name: true } },
                transaction: { select: { post_date: true } },
            },
        });

        if (splits.length !== splitGuids.length) {
            return NextResponse.json(
                { error: 'Some splits not found' },
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
                where: { guid: { in: splitGuids } },
                select: {
                    guid: true,
                    tx_guid: true,
                    account_guid: true,
                    reconcile_state: true,
                    account: { select: { name: true } },
                    transaction: { select: { post_date: true } },
                },
            });
            // Authoritative check: read under the parent lock, so a
            // concurrent reconcile cannot slip between it and the write.
            assertSplitsNotProtected('move these splits to another account', freshSplits);
            await assertNotLocked(
                roleResult.bookGuid,
                freshSplits.map(s => s.transaction?.post_date),
                { bypassCache: true, client: tx },
            );

            // Belt and braces: the protected states are also in the WHERE
            // clause, so the write can never land on a reconciled row even if
            // a future caller reaches this code without the lock.
            const moved = await tx.splits.updateMany({
                where: {
                    guid: { in: splitGuids },
                    reconcile_state: { notIn: [...PROTECTED_RECONCILE_STATES] },
                },
                data: { account_guid: targetAccountGuid },
            });
            if (moved.count !== splitGuids.length) {
                // Fewer rows moved than asked for while holding the lock: the
                // only predicate that can exclude one is the reconcile state.
                await assertNoReconciledSplits(
                    'move these splits to another account',
                    { splitGuids },
                    { client: tx },
                );
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
        console.error('Failed to bulk move splits:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
