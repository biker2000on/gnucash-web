import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

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
        const existingSplit = await query(
            'SELECT guid FROM splits WHERE guid = $1',
            [guid]
        );
        if (existingSplit.rows.length === 0) {
            return NextResponse.json({ error: 'Split not found' }, { status: 404 });
        }

        // Update the split
        const reconcileDate = body.reconcile_state === 'y'
            ? (body.reconcile_date || new Date().toISOString())
            : null;

        await query(
            `UPDATE splits
             SET reconcile_state = $2, reconcile_date = $3
             WHERE guid = $1`,
            [guid, body.reconcile_state, reconcileDate]
        );

        // Return the updated split
        const result = await query(
            `SELECT s.*, a.name as account_name
             FROM splits s
             JOIN accounts a ON s.account_guid = a.guid
             WHERE s.guid = $1`,
            [guid]
        );

        return NextResponse.json(result.rows[0]);
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
            ? (reconcile_date || new Date().toISOString())
            : null;

        // Bulk update
        await query(
            `UPDATE splits
             SET reconcile_state = $2, reconcile_date = $3
             WHERE guid = ANY($1)`,
            [splits, reconcile_state, date]
        );

        return NextResponse.json({
            success: true,
            updated: splits.length,
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
