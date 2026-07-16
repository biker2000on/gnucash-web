import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { runFundingRules } from '@/lib/services/funding-rules.service';

/**
 * POST /api/budgets/funding-rules/run
 * Run the funding-rule sweep for the active book right now (same engine the
 * worker's 30-minute sweep uses — idempotent via the autofund num stamp).
 *
 * Body (optional): { sinceDays?: number } — scan window, default 3, max 31.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null) as { sinceDays?: unknown } | null;
        const sinceDaysRaw = Number(body?.sinceDays);
        const sinceDays = Number.isFinite(sinceDaysRaw) ? sinceDaysRaw : undefined;

        const result = await runFundingRules({ bookGuid, sinceDays });
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error running funding rules:', error);
        return NextResponse.json({ error: 'Failed to run funding rules' }, { status: 500 });
    }
}
