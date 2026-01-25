import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

interface BulkReconcileBody {
    splits: string[];
    reconcile_state: 'n' | 'c' | 'y';
    reconcile_date?: string;
}

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

        // Bulk update all splits
        const result = await prisma.splits.updateMany({
            where: {
                guid: { in: body.splits },
            },
            data: {
                reconcile_state: body.reconcile_state,
                reconcile_date: reconcileDate,
            },
        });

        return NextResponse.json({
            success: true,
            updated: result.count,
            reconcile_state: body.reconcile_state,
            reconcile_date: reconcileDate,
        });
    } catch (error) {
        console.error('Error bulk updating reconcile states:', error);
        return NextResponse.json(
            { error: 'Failed to update reconcile states' },
            { status: 500 }
        );
    }
}
