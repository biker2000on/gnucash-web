import { NextRequest, NextResponse } from 'next/server';
import { detectRecurringCharges } from '@/lib/recurring-detection';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/tools/subscriptions
 *
 * Detects recurring charges / subscriptions from real spending.
 *
 * Query params:
 *   months          Lookback window in months (default 24, clamped 3-60)
 *   minOccurrences  Minimum charges before a series counts (default 3, clamped 2-12)
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const monthsParam = parseInt(searchParams.get('months') ?? '', 10);
        const months = Number.isFinite(monthsParam)
            ? Math.min(60, Math.max(3, monthsParam))
            : 24;

        const minOccParam = parseInt(searchParams.get('minOccurrences') ?? '', 10);
        const minOccurrences = Number.isFinite(minOccParam)
            ? Math.min(12, Math.max(2, minOccParam))
            : 3;

        const bookAccountGuids = await getBookAccountGuids();
        const result = await detectRecurringCharges(bookAccountGuids, {
            months,
            minOccurrences,
        });

        return NextResponse.json({
            ...result,
            params: { months, minOccurrences },
            generatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error detecting recurring charges:', error);
        return NextResponse.json(
            { error: 'Failed to detect recurring charges' },
            { status: 500 }
        );
    }
}
