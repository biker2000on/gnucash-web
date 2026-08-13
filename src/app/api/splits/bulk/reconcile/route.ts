import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { publishDataChange } from '@/lib/data-events';
import { lockTransactionsForUpdate } from '@/lib/services/reconciled-split.service';

interface BulkReconcileBody {
    splits: string[];
    reconcile_state: 'n' | 'c' | 'y';
    reconcile_date?: string;
}

class SplitNotInBookError extends Error {}

/**
 * @openapi
 * /api/splits/bulk/reconcile:
 *   post:
 *     description: Bulk update reconciliation state for multiple splits.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - splits
 *               - reconcile_state
 *             properties:
 *               splits:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of split GUIDs to update
 *               reconcile_state:
 *                 type: string
 *                 enum: [n, c, y]
 *                 description: "n=not reconciled, c=cleared, y=reconciled"
 *               reconcile_date:
 *                 type: string
 *                 format: date
 *                 description: Date of reconciliation (only used when state is 'y')
 *     responses:
 *       200:
 *         description: Splits updated successfully.
 *       400:
 *         description: Invalid request.
 *       500:
 *         description: Server error.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body: BulkReconcileBody = await request.json();

        // Validate input
        if (!Array.isArray(body.splits) || body.splits.length === 0) {
            return NextResponse.json(
                { error: 'splits array is required and must not be empty' },
                { status: 400 }
            );
        }

        if (!['n', 'c', 'y'].includes(body.reconcile_state)) {
            return NextResponse.json(
                { error: 'Invalid reconcile_state. Must be n, c, or y.' },
                { status: 400 }
            );
        }

        const reconcileDate = body.reconcile_state === 'y'
            ? new Date(body.reconcile_date || new Date().toISOString())
            : null;
        const splitGuids = [...new Set(body.splits)];
        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);
        if (bookAccountGuids.length === 0) {
            return NextResponse.json(
                { error: 'One or more splits not found in this book' },
                { status: 404 }
            );
        }

        // Fast-fail a batch containing a split absent from this book. The
        // in-transaction checks below are authoritative; this avoids opening
        // a transaction for an immediately-invalid request. Rejection is
        // atomic because silently reconciling only a subset would leave
        // callers unable to tell which requested rows were changed and makes
        // safe retries difficult.
        const scopedTargets = await prisma.splits.findMany({
            where: {
                guid: { in: splitGuids },
                account_guid: { in: bookAccountGuids },
            },
            select: { guid: true },
        });
        if (scopedTargets.length !== splitGuids.length) {
            return NextResponse.json(
                { error: 'One or more splits not found in this book' },
                { status: 404 }
            );
        }
        // Bulk update all splits under the canonical parent-transaction lock
        // (guid order), matching every other split-writing path.
        //
        // This route is one half of the reconciled-split guard's contract:
        // that guard is only race-free because EVERY writer of
        // reconcile_state takes the parent transaction lock first, so a
        // reconcile cannot commit between a guarded path's check and its
        // write. This used to be a bare updateMany outside any transaction —
        // exactly the writer that could slip through — so it now locks like
        // its siblings and bumps enter_date so stale editors 409.
        const result = await prisma.$transaction(async (tx) => {
            const targets = await tx.splits.findMany({
                where: {
                    guid: { in: splitGuids },
                    account_guid: { in: bookAccountGuids },
                },
                select: { guid: true, tx_guid: true },
            });
            if (targets.length !== splitGuids.length) {
                throw new SplitNotInBookError();
            }
            const parentTxGuids = [...new Set(targets.map(s => s.tx_guid))].sort();
            await lockTransactionsForUpdate(parentTxGuids, tx);

            const updated = await tx.splits.updateMany({
                where: {
                    guid: { in: splitGuids },
                    account_guid: { in: bookAccountGuids },
                },
                data: {
                    reconcile_state: body.reconcile_state,
                    reconcile_date: reconcileDate,
                },
            });
            if (updated.count !== splitGuids.length) {
                throw new SplitNotInBookError();
            }
            if (parentTxGuids.length > 0) {
                await tx.transactions.updateMany({
                    where: { guid: { in: parentTxGuids } },
                    data: { enter_date: new Date() },
                });
            }
            return updated;
        });

        void publishDataChange(roleResult.bookGuid, 'transactions', { action: 'bulk' });

        return NextResponse.json({
            success: true,
            updated: result.count,
            reconcile_state: body.reconcile_state,
            reconcile_date: reconcileDate,
        });
    } catch (error) {
        if (error instanceof SplitNotInBookError) {
            return NextResponse.json(
                { error: 'One or more splits not found in this book' },
                { status: 404 }
            );
        }
        console.error('Error bulk updating reconcile states:', error);
        return NextResponse.json(
            { error: 'Failed to update reconcile states' },
            { status: 500 }
        );
    }
}
