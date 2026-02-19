import { NextRequest, NextResponse } from 'next/server';
import { generateBalanceSheet } from '@/lib/reports/balance-sheet';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            compareToPrevious: searchParams.get('compareToPrevious') === 'true',
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
            bookAccountGuids,
        };

        const report = await generateBalanceSheet(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating balance sheet:', error);
        return NextResponse.json(
            { error: 'Failed to generate balance sheet' },
            { status: 500 }
        );
    }
}
