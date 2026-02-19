import { NextRequest, NextResponse } from 'next/server';
import { generateTrialBalance } from '@/lib/reports/trial-balance';
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
            showZeroBalances: searchParams.get('showZeroBalances') === 'true',
            bookAccountGuids,
        };

        const report = await generateTrialBalance(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating trial balance:', error);
        return NextResponse.json(
            { error: 'Failed to generate trial balance' },
            { status: 500 }
        );
    }
}
