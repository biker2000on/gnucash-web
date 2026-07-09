import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { scanBudgetAlerts } from '@/lib/budget-envelope';

/**
 * @openapi
 * /api/budgets/alerts/scan:
 *   post:
 *     description: >
 *       Manually scan every active budget in the current book for overspend /
 *       threshold / projected-overspend conditions and create notifications
 *       for new alerts (deduped by budget + account + period + kind).
 *     responses:
 *       200:
 *         description: "{ detected, created } summary of the scan."
 */
export async function POST() {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { user, bookGuid } = roleResult;

        const result = await scanBudgetAlerts(bookGuid, { userId: user.id });
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error scanning budget alerts:', error);
        return NextResponse.json({ error: 'Failed to scan budget alerts' }, { status: 500 });
    }
}
