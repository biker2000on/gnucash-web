import { NextRequest, NextResponse } from 'next/server';
import { BudgetService, UpdateBudgetSchema } from '@/lib/services/budget.service';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/budgets/{guid}:
 *   get:
 *     description: Get a single budget with all amounts.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Budget details with amounts.
 *       404:
 *         description: Budget not found.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        const budget = await BudgetService.getById(guid);
        if (!budget) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }

        return NextResponse.json(budget);
    } catch (error) {
        console.error('Error fetching budget:', error);
        return NextResponse.json({ error: 'Failed to fetch budget' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/budgets/{guid}:
 *   put:
 *     description: Update a budget.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Budget updated successfully.
 *       400:
 *         description: Validation error.
 *       404:
 *         description: Budget not found.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const body = await request.json();

        const parseResult = UpdateBudgetSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const budget = await BudgetService.update(guid, parseResult.data);
        return NextResponse.json(budget);
    } catch (error) {
        console.error('Error updating budget:', error);
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return NextResponse.json({ error: error.message }, { status: 404 });
            }
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to update budget' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/budgets/{guid}:
 *   delete:
 *     description: Delete a budget.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Budget deleted successfully.
 *       404:
 *         description: Budget not found.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        const result = await BudgetService.delete(guid);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error deleting budget:', error);
        if (error instanceof Error) {
            if (error.message.includes('not found')) {
                return NextResponse.json({ error: error.message }, { status: 404 });
            }
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to delete budget' }, { status: 500 });
    }
}
