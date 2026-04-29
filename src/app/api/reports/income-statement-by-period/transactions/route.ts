import { NextRequest, NextResponse } from 'next/server';
import { fetchPeriodTransactions } from '@/lib/reports/income-statement-by-period-transactions';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const accountGuid = searchParams.get('accountGuid');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        if (!accountGuid || !startDate || !endDate) {
            return NextResponse.json(
                { error: 'accountGuid, startDate, and endDate are required' },
                { status: 400 },
            );
        }

        const bookAccountGuids = await getBookAccountGuids();

        const result = await fetchPeriodTransactions({
            accountGuid,
            startDate,
            endDate,
            bookAccountGuids,
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Error fetching income-statement period transactions:', error);
        return NextResponse.json(
            { error: 'Failed to fetch transactions' },
            { status: 500 },
        );
    }
}
