import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateDayOfWeek } from '@/lib/reports/day-of-week';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const startDate = searchParams.get('startDate') || `${now.getFullYear()}-01-01`;
        const endDate = searchParams.get('endDate') || now.toISOString().split('T')[0];
        if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
            return NextResponse.json({ error: 'Dates must be in YYYY-MM-DD format' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();

        const report = await generateDayOfWeek({ startDate, endDate, bookAccountGuids });
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating day-of-week report:', error);
        return NextResponse.json(
            { error: 'Failed to generate day-of-week report' },
            { status: 500 }
        );
    }
}
