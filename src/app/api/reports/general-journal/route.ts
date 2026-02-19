import { NextRequest, NextResponse } from 'next/server';
import { generateGeneralJournal } from '@/lib/reports/general-journal';
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
            accountTypes: searchParams.get('accountTypes')?.split(',').filter(Boolean),
            bookAccountGuids,
        };

        const report = await generateGeneralJournal(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating general journal:', error);
        return NextResponse.json(
            { error: 'Failed to generate general journal' },
            { status: 500 }
        );
    }
}
