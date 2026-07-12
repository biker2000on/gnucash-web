import { NextRequest, NextResponse } from 'next/server';
import { generateBudgetBalanceSheet } from '@/lib/reports/budget-statements';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/reports/budget-balance-sheet
 *
 * Params:
 *   budget  (required) budget GUID; must belong to the active book
 *   period  optional period index; balances are projected through the END of
 *           this period (default: the budget's last period)
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const budgetGuid = searchParams.get('budget');
        if (!budgetGuid) {
            return NextResponse.json(
                { error: 'Missing required "budget" parameter' },
                { status: 400 }
            );
        }

        const rawPeriod = searchParams.get('period');
        const parsed = rawPeriod === null || rawPeriod === '' ? NaN : parseInt(rawPeriod, 10);
        // NaN → very large index; the generator clamps to the last period.
        const periodIndex = Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;

        const bookAccountGuids = await getBookAccountGuids();

        const report = await generateBudgetBalanceSheet(bookAccountGuids, budgetGuid, periodIndex);
        if (!report) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating budget balance sheet:', error);
        return NextResponse.json(
            { error: 'Failed to generate budget balance sheet' },
            { status: 500 }
        );
    }
}
