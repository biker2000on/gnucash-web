import { NextRequest, NextResponse } from 'next/server';
import { generateSalesTaxReport } from '@/lib/business/business-reports';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const now = new Date();
        const defaultStart = `${now.getUTCFullYear()}-01-01`;
        const defaultEnd = now.toISOString().slice(0, 10);

        const startDate = searchParams.get('startDate') ?? defaultStart;
        const endDate = searchParams.get('endDate') ?? defaultEnd;
        if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
            return NextResponse.json(
                { error: 'startDate and endDate must be YYYY-MM-DD' },
                { status: 400 }
            );
        }

        const bookAccountGuids = await getBookAccountGuids();
        const report = await generateSalesTaxReport(startDate, endDate, bookAccountGuids);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating sales tax report:', error);
        return NextResponse.json(
            { error: 'Failed to generate sales tax report' },
            { status: 500 }
        );
    }
}
