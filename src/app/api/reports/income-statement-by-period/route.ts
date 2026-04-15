import { NextRequest, NextResponse } from 'next/server';
import { generateIncomeStatementByPeriod } from '@/lib/reports/income-statement-by-period';
import { PeriodGrouping, ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const groupingParam = (searchParams.get('grouping') || 'month') as PeriodGrouping;
        const grouping: PeriodGrouping =
            groupingParam === 'month' || groupingParam === 'quarter' || groupingParam === 'year'
                ? groupingParam
                : 'month';

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
            bookAccountGuids,
        };

        const report = await generateIncomeStatementByPeriod(filters, grouping);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating income statement by period:', error);
        return NextResponse.json(
            { error: 'Failed to generate report' },
            { status: 500 }
        );
    }
}
