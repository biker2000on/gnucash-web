import { NextRequest, NextResponse } from 'next/server';
import { generateBalanceSheet } from '@/lib/reports/balance-sheet';
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
