import { NextRequest, NextResponse } from 'next/server';
import { generateIncomeStatement } from '@/lib/reports/income-statement';
import { ReportFilters } from '@/lib/reports/types';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            compareToPrevious: searchParams.get('compareToPrevious') === 'true',
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
        };

        const report = await generateIncomeStatement(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating income statement:', error);
        return NextResponse.json(
            { error: 'Failed to generate income statement' },
            { status: 500 }
        );
    }
}
