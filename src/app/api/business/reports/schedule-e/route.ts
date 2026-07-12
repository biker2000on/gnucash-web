import { NextRequest, NextResponse } from 'next/server';
import { generateScheduleE } from '@/lib/reports/schedule-e';
import { getBookAccountGuids, getActiveBookRootGuid } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/business/reports/schedule-e?year=YYYY
 * Schedule E (Part I) estimate for the active book's defined rental
 * properties. Rentals are common on household books, so this works for ANY
 * book — do not gate it on the business entity type.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const yearParam = searchParams.get('year');
        const year = yearParam ? parseInt(yearParam, 10) : new Date().getUTCFullYear();
        if (!Number.isInteger(year) || year < 1900 || year > 2200) {
            return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
        }

        const [bookAccountGuids, bookRootGuid] = await Promise.all([
            getBookAccountGuids(),
            getActiveBookRootGuid(),
        ]);
        const report = await generateScheduleE(bookAccountGuids, bookRootGuid, year);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating Schedule E report:', error);
        return NextResponse.json(
            { error: 'Failed to generate Schedule E report' },
            { status: 500 }
        );
    }
}
