import { NextRequest, NextResponse } from 'next/server';
import { generateSalesByCustomer } from '@/lib/reports/sales-by-customer';
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

        const report = await generateSalesByCustomer(filters);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating sales by customer report:', error);
        return NextResponse.json(
            { error: 'Failed to generate sales by customer report' },
            { status: 500 }
        );
    }
}
