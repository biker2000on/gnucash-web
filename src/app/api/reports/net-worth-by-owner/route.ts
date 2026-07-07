import { NextRequest, NextResponse } from 'next/server';
import { generateNetWorthByOwner } from '@/lib/reports/net-worth-by-owner';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        // Point-in-time report: balances through asOf (endDate accepted as an
        // alias so ReportViewer-driven pages work unchanged). Defaults to today.
        const asOf = searchParams.get('asOf') ?? searchParams.get('endDate');

        const filters: ReportFilters = {
            startDate: null,
            endDate: asOf,
            bookAccountGuids,
        };

        const report = await generateNetWorthByOwner(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating net worth by owner report:', error);
        return NextResponse.json(
            { error: 'Failed to generate net worth by owner report' },
            { status: 500 }
        );
    }
}
