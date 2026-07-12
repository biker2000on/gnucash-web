import { NextRequest, NextResponse } from 'next/server';
import { generateCustomerSummary } from '@/lib/business/customer-summary';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/business/reports/customer-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Per-customer sales, expenses, profit and markup for the active book.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        if (!startDate || !endDate || !ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
            return NextResponse.json(
                { error: 'startDate and endDate are required (YYYY-MM-DD)' },
                { status: 400 }
            );
        }

        const bookAccountGuids = await getBookAccountGuids();
        const report = await generateCustomerSummary(startDate, endDate, bookAccountGuids);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating customer summary:', error);
        return NextResponse.json(
            { error: 'Failed to generate customer summary' },
            { status: 500 }
        );
    }
}
