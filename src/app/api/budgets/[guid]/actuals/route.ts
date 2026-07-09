import { NextRequest, NextResponse } from 'next/server';
import { loadBudgetActuals, toActualsSummary } from '@/lib/budget-actuals';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/budgets/{guid}/actuals:
 *   get:
 *     description: >
 *       Budget vs actual progress for every period, current-period pacing
 *       (elapsed fraction, pace ratio, projected end-of-period spend, status),
 *       and a year-over-year comparison against the same calendar ranges one
 *       year earlier. Actuals are book-scoped and sign-corrected (income
 *       negated). Pass summary=1 for the compact list-card payload.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: summary
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *       - name: compare
 *         in: query
 *         required: false
 *         description: "'prior-year' (default) or 'none' to omit the YoY block."
 *         schema:
 *           type: string
 *       - name: asOf
 *         in: query
 *         required: false
 *         description: Override the as-of date (YYYY-MM-DD), mainly for testing.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Budget progress payload.
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
        const { searchParams } = new URL(request.url);

        const asOfParam = searchParams.get('asOf');
        const asOf = asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? asOfParam : undefined;

        const result = await loadBudgetActuals(guid, { asOf });
        if (!result) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }

        if (searchParams.get('summary') === '1') {
            return NextResponse.json(toActualsSummary(result));
        }

        if (searchParams.get('compare') === 'none') {
            return NextResponse.json({ ...result, yoy: null });
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error('Error computing budget actuals:', error);
        return NextResponse.json(
            { error: 'Failed to compute budget actuals' },
            { status: 500 }
        );
    }
}
