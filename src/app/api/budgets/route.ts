import { NextRequest, NextResponse } from 'next/server';
import { BudgetService, CreateBudgetSchema } from '@/lib/services/budget.service';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/budgets:
 *   get:
 *     description: List all budgets.
 *     responses:
 *       200:
 *         description: A list of budgets.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const budgets = await BudgetService.list();
        return NextResponse.json(budgets);
    } catch (error) {
        console.error('Error fetching budgets:', error);
        return NextResponse.json({ error: 'Failed to fetch budgets' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/budgets:
 *   post:
 *     description: Create a new budget.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               num_periods:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 60
 *                 default: 12
 *     responses:
 *       201:
 *         description: Budget created successfully.
 *       400:
 *         description: Validation error.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json();

        const parseResult = CreateBudgetSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const budget = await BudgetService.create(parseResult.data);
        return NextResponse.json(budget, { status: 201 });
    } catch (error) {
        console.error('Error creating budget:', error);
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to create budget' }, { status: 500 });
    }
}
