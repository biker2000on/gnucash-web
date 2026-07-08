import { NextRequest, NextResponse } from 'next/server';
import { runDataHealth } from '@/lib/data-health';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/tools/data-health
 *
 * Runs the read-only data-health checks against the active book and returns an
 * aggregate report with an overall score.
 *
 * Query params:
 *   staleDays         Prices older than this many days are stale (default 7, clamped 1-365)
 *   unreconciledDays  Unreconciled splits older than this age into the report (default 90, clamped 1-3650)
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);

        const staleParam = parseInt(searchParams.get('staleDays') ?? '', 10);
        const staleDays = Number.isFinite(staleParam)
            ? Math.min(365, Math.max(1, staleParam))
            : 7;

        const unreconciledParam = parseInt(searchParams.get('unreconciledDays') ?? '', 10);
        const unreconciledDays = Number.isFinite(unreconciledParam)
            ? Math.min(3650, Math.max(1, unreconciledParam))
            : 90;

        const bookAccountGuids = await getBookAccountGuids();
        const report = await runDataHealth(bookAccountGuids, { staleDays, unreconciledDays });

        return NextResponse.json(report);
    } catch (error) {
        console.error('Error running data health checks:', error);
        return NextResponse.json(
            { error: 'Failed to run data health checks' },
            { status: 500 }
        );
    }
}
