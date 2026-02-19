import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { requireRole } from '@/lib/auth';

interface ReconcileBody {
    reconcile_state: 'n' | 'c' | 'y';
    reconcile_date?: string;
}

/**
 * @openapi
 * /api/splits/{guid}/reconcile:
 *   patch:
 *     description: Update the reconciliation state of a split.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         description: The GUID of the split to update.
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
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
 *         description: Split updated successfully.
 *       400:
 *         description: Invalid reconcile state.
 *       404:
 *         description: Split not found.
 *       500:
 *         description: Server error.
 */
export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const body: ReconcileBody = await request.json();

        // Validate reconcile state
        if (!['n', 'c', 'y'].includes(body.reconcile_state)) {
            return NextResponse.json(
                { error: 'Invalid reconcile_state. Must be n, c, or y.' },
                { status: 400 }
            );
        }

        // Verify split exists
        const existingSplit = await prisma.splits.findUnique({
            where: { guid },
        });
        if (!existingSplit) {
            return NextResponse.json({ error: 'Split not found' }, { status: 404 });
        }

        // Update the split
        const reconcileDate = body.reconcile_state === 'y'
            ? new Date(body.reconcile_date || new Date().toISOString())
            : null;

        const updatedSplit = await prisma.splits.update({
            where: { guid },
            data: {
                reconcile_state: body.reconcile_state,
                reconcile_date: reconcileDate,
            },
            include: {
                account: true,
            },
        });

        // Return the updated split
        const result = {
            guid: updatedSplit.guid,
            tx_guid: updatedSplit.tx_guid,
            account_guid: updatedSplit.account_guid,
            memo: updatedSplit.memo,
            action: updatedSplit.action,
            reconcile_state: updatedSplit.reconcile_state,
            reconcile_date: updatedSplit.reconcile_date,
            value_num: updatedSplit.value_num,
            value_denom: updatedSplit.value_denom,
            quantity_num: updatedSplit.quantity_num,
            quantity_denom: updatedSplit.quantity_denom,
            lot_guid: updatedSplit.lot_guid,
            account_name: updatedSplit.account.name,
        };

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error updating split reconcile state:', error);
        return NextResponse.json(
            { error: 'Failed to update reconcile state' },
            { status: 500 }
        );
    }
}

/**
 * Bulk update reconciliation states
 */
export async function POST(
    request: Request
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();
        const { splits, reconcile_state, reconcile_date } = body;

        if (!Array.isArray(splits) || splits.length === 0) {
            return NextResponse.json(
                { error: 'splits array is required' },
                { status: 400 }
            );
        }

        if (!['n', 'c', 'y'].includes(reconcile_state)) {
            return NextResponse.json(
                { error: 'Invalid reconcile_state. Must be n, c, or y.' },
                { status: 400 }
            );
        }

        const date = reconcile_state === 'y'
            ? new Date(reconcile_date || new Date().toISOString())
            : null;

        // Bulk update
        const result = await prisma.splits.updateMany({
            where: {
                guid: { in: splits },
            },
            data: {
                reconcile_state,
                reconcile_date: date,
            },
        });

        return NextResponse.json({
            success: true,
            updated: result.count,
            reconcile_state,
        });
    } catch (error) {
        console.error('Error bulk updating reconcile states:', error);
        return NextResponse.json(
            { error: 'Failed to update reconcile states' },
            { status: 500 }
        );
    }
}
