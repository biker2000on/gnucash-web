import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateNetWorthAttribution } from '@/lib/reports/net-worth-attribution';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Net-Worth Attribution report API
 *
 * GET /api/reports/net-worth-attribution?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Decomposes the net-worth change over the date range into savings, market
 * gains, debt paydown, and a residual other bucket, with a monthly series
 * and per-account drill-down. Defaults to the current calendar year.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const startDate = searchParams.get('startDate') || `${now.getUTCFullYear()}-01-01`;
        const endDate = searchParams.get('endDate') || now.toISOString().split('T')[0];

        if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
            return NextResponse.json(
                { error: 'Dates must be in YYYY-MM-DD format' },
                { status: 400 }
            );
        }
        if (startDate > endDate) {
            return NextResponse.json(
                { error: 'startDate must be on or before endDate' },
                { status: 400 }
            );
        }

        const bookAccountGuids = await getBookAccountGuids();

        const report = await generateNetWorthAttribution({
            bookAccountGuids,
            startDate,
            endDate,
        });

        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating net-worth attribution report:', error);
        return NextResponse.json(
            { error: 'Failed to generate net-worth attribution report' },
            { status: 500 }
        );
    }
}
