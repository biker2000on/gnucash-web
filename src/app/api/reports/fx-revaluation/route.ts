import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generateFxRevaluation } from '@/lib/reports/fx-revaluation';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/reports/fx-revaluation?startDate=&endDate=
 *
 * Per-currency FX exposure with average acquisition rate, current rate and
 * unrealized gain/loss. startDate/endDate bound the REALIZED gain window
 * (default: current year to date). Read-only, book-scoped.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const now = new Date();
        const periodStart = searchParams.get('startDate') || `${now.getFullYear()}-01-01`;
        const periodEnd = searchParams.get('endDate') || now.toISOString().split('T')[0];
        if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
            return NextResponse.json({ error: 'Dates must be in YYYY-MM-DD format' }, { status: 400 });
        }

        const bookAccountGuids = await getBookAccountGuids();

        const report = await generateFxRevaluation({ bookAccountGuids, periodStart, periodEnd });
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating FX revaluation report:', error);
        return NextResponse.json(
            { error: 'Failed to generate FX revaluation report' },
            { status: 500 }
        );
    }
}
