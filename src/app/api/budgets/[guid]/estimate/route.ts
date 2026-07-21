import { NextRequest, NextResponse } from 'next/server';
import { computeBudgetEstimate, parseEstimateMethod } from '@/lib/budget-estimate';
import { requireRole } from '@/lib/auth';

/**
 * @openapi
 * /api/budgets/{guid}/estimate:
 *   get:
 *     description: >
 *       Per-period budget estimate for an account (subtree rolled up).
 *       method=average|median (trailing-months statistic, flat per period) or
 *       method=seasonal (same calendar range last year, per period).
 *       periodAmounts are raw GnuCash-signed (income negative), store-ready.
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
        const accountGuid = searchParams.get('account_guid');
        const method = parseEstimateMethod(searchParams.get('method'));
        const months = parseInt(searchParams.get('months') || '12', 10);

        if (!accountGuid) {
            return NextResponse.json(
                { error: 'Missing required query parameter: account_guid' },
                { status: 400 }
            );
        }

        if (isNaN(months) || months < 1 || months > 60) {
            return NextResponse.json(
                { error: 'Invalid months parameter (must be 1-60)' },
                { status: 400 }
            );
        }

        const estimate = await computeBudgetEstimate(guid, accountGuid, method, months);
        if (!estimate) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }
        return NextResponse.json(estimate);
    } catch (error) {
        console.error('Error computing budget estimate:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to get estimate' },
            { status: 500 }
        );
    }
}
