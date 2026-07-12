import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { loadFixedIncomePositions, summarizeFixedIncome } from '@/lib/fixed-income';

/**
 * GET /api/investments/fixed-income
 *
 * Fixed-income (bond / CD / treasury / I-bond) ladder report for the active
 * book: positions with YTM and current yield, maturity-year ladder buckets,
 * weighted averages, upcoming maturities, and coupon estimates.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const positions = await loadFixedIncomePositions(bookAccountGuids);
        const summary = summarizeFixedIncome(positions, new Date());
        return NextResponse.json(summary);
    } catch (error) {
        console.error('Fixed income API error:', error);
        return NextResponse.json(
            { error: 'Failed to load fixed income data' },
            { status: 500 },
        );
    }
}
