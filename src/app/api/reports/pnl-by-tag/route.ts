import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { generatePnlByTag } from '@/lib/reports/pnl-by-tag';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/reports/pnl-by-tag?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Income/expense totals per transaction tag for the period. Auth: readonly.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        for (const [name, value] of [['startDate', startDate], ['endDate', endDate]] as const) {
            if (value && !DATE_RE.test(value)) {
                return NextResponse.json({ error: `${name} must be YYYY-MM-DD` }, { status: 400 });
            }
        }

        const bookAccountGuids = await getBookAccountGuids();
        const report = await generatePnlByTag({
            bookGuid: roleResult.bookGuid,
            bookAccountGuids,
            startDate,
            endDate,
        });
        return NextResponse.json(report);
    } catch (error) {
        console.error('Error generating P&L by tag:', error);
        return NextResponse.json({ error: 'Failed to generate P&L by tag' }, { status: 500 });
    }
}
