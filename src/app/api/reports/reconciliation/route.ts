import { NextRequest, NextResponse } from 'next/server';
import { generateReconciliation } from '@/lib/reports/reconciliation';
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

        // Parse accountGuids parameter (comma-separated)
        const accountGuidsParam = searchParams.get('accountGuids');
        const accountGuids = accountGuidsParam
            ? accountGuidsParam.split(',').filter(Boolean)
            : undefined;

        const report = await generateReconciliation(filters, accountGuids);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating reconciliation report:', error);
        return NextResponse.json(
            { error: 'Failed to generate reconciliation report' },
            { status: 500 }
        );
    }
}
