import { NextRequest, NextResponse } from 'next/server';
import { generateCashFlow } from '@/lib/reports/cash-flow';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            compareToPrevious: searchParams.get('compareToPrevious') === 'true',
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
            bookAccountGuids,
        };

        const report = await generateCashFlow(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating cash flow statement:', error);
        return NextResponse.json(
            { error: 'Failed to generate cash flow statement' },
            { status: 500 }
        );
    }
}
