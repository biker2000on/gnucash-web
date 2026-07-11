import { NextRequest, NextResponse } from 'next/server';
import { generateExpensesByVendor } from '@/lib/reports/expenses-by-vendor';
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
            bookAccountGuids,
        };

        const report = await generateExpensesByVendor(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating expenses by vendor report:', error);
        return NextResponse.json(
            { error: 'Failed to generate expenses by vendor report' },
            { status: 500 }
        );
    }
}
