import { NextRequest, NextResponse } from 'next/server';
import { generateTransactionReport } from '@/lib/reports/transaction-report';
import { ReportFilters } from '@/lib/reports/types';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            compareToPrevious: searchParams.get('compareToPrevious') === 'true',
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
            accountTypes: searchParams.get('accountTypes')?.split(',').filter(Boolean),
        };

        const report = await generateTransactionReport(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating transaction report:', error);
        return NextResponse.json(
            { error: 'Failed to generate transaction report' },
            { status: 500 }
        );
    }
}
