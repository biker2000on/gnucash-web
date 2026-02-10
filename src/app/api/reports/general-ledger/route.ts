import { NextRequest, NextResponse } from 'next/server';
import { generateGeneralLedger } from '@/lib/reports/general-ledger';
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
            accountTypes: searchParams.get('accountTypes')?.split(',').filter(Boolean),
            bookAccountGuids,
        };

        const report = await generateGeneralLedger(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating general ledger:', error);
        return NextResponse.json(
            { error: 'Failed to generate general ledger' },
            { status: 500 }
        );
    }
}
