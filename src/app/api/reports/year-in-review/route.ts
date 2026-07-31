import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { generateYearInReview } from '@/lib/reports/year-in-review';

/**
 * Year in Review report API
 *
 * GET /api/reports/year-in-review?year=YYYY
 *
 * Assembles the annual "wrapped" card set for one calendar year.
 * Defaults to the current calendar year (UTC).
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const yearParam = searchParams.get('year');
        const year = yearParam
            ? parseInt(yearParam, 10)
            : new Date().getUTCFullYear();

        if (!Number.isInteger(year) || year < 1900 || year > 2200) {
            return NextResponse.json(
                { error: 'year must be a four-digit year' },
                { status: 400 }
            );
        }

        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);

        const report = await generateYearInReview(roleResult.bookGuid, bookAccountGuids, year);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating year-in-review report:', error);
        return NextResponse.json(
            { error: 'Failed to generate year-in-review report' },
            { status: 500 }
        );
    }
}
