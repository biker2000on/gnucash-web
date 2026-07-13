import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { compareToBls, clampHouseholdSize } from '@/lib/bls-comparison';

/**
 * GET /api/reports/bls-comparison?year=&householdSize=
 *
 * Compares the book's annual spending by category to approximate BLS
 * Consumer Expenditure Survey national averages. Read-only, book-scoped.
 * householdSize 1..5 (5 = "5 or more"); defaults: last full year, size 2.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const rawYear = searchParams.get('year');
        const year = rawYear ? Number(rawYear) : now.getFullYear() - 1;
        if (!Number.isInteger(year) || year < 1990 || year > 2100) {
            return NextResponse.json({ error: 'year must be an integer between 1990 and 2100' }, { status: 400 });
        }

        const rawSize = searchParams.get('householdSize');
        const parsedSize = rawSize ? Number(rawSize) : 2;
        if (!Number.isFinite(parsedSize)) {
            return NextResponse.json({ error: 'householdSize must be a number 1-5' }, { status: 400 });
        }
        const householdSize = clampHouseholdSize(parsedSize);

        const bookAccountGuids = await getBookAccountGuids();

        const report = await compareToBls(bookAccountGuids, year, householdSize);
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating BLS comparison report:', error);
        return NextResponse.json(
            { error: 'Failed to generate BLS comparison report' },
            { status: 500 }
        );
    }
}
