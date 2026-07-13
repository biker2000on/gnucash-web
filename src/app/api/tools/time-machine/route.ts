import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getEffectiveStartDate } from '@/lib/date-utils';
import { bookAsOf, compareAsOf } from '@/lib/time-machine';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(raw: string | null): string | null {
    if (!raw) return null;
    if (!DATE_FORMAT.test(raw)) return null;
    const parsed = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : raw;
}

/**
 * GET /api/tools/time-machine?date=YYYY-MM-DD[&compareTo=YYYY-MM-DD]
 *
 * Read-only, book-scoped snapshot of the account tree and summary as of
 * end-of-day on `date` (default today). With `compareTo`, also returns the
 * second snapshot and a per-account diff (compareTo → date).
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const rawDate = searchParams.get('date');
        const rawCompareTo = searchParams.get('compareTo');

        const date = parseDateParam(rawDate) ?? new Date().toISOString().slice(0, 10);
        if (rawDate && !parseDateParam(rawDate)) {
            return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 });
        }
        const compareTo = parseDateParam(rawCompareTo);
        if (rawCompareTo && !compareTo) {
            return NextResponse.json({ error: 'Invalid compareTo date (expected YYYY-MM-DD)' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();
        const earliest = await getEffectiveStartDate(null, bookAccountGuids);

        const current = await bookAsOf(bookAccountGuids, date);
        const compare = compareTo ? await bookAsOf(bookAccountGuids, compareTo) : null;
        const diff = compare ? compareAsOf(compare, current) : null;

        return NextResponse.json({
            current,
            compare,
            diff,
            earliestDate: earliest.toISOString().slice(0, 10),
        });
    } catch (error) {
        console.error('Error running time machine:', error);
        return NextResponse.json({ error: 'Failed to compute as-of balances' }, { status: 500 });
    }
}
