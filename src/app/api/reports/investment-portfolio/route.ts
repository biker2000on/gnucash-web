import { NextRequest, NextResponse } from 'next/server';
import { generateInvestmentPortfolio } from '@/lib/reports/investment-portfolio';
import { ReportFilters } from '@/lib/reports/types';
import { getBookAccountGuids } from '@/lib/book-scope';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const filters: ReportFilters = {
            startDate: searchParams.get('startDate'),
            endDate: searchParams.get('endDate'),
            bookAccountGuids,
        };

        const showZeroShares = searchParams.get('showZeroShares') === 'true';

        const report = await generateInvestmentPortfolio(filters, showZeroShares);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating investment portfolio:', error);
        return NextResponse.json(
            { error: 'Failed to generate investment portfolio' },
            { status: 500 }
        );
    }
}
