/**
 * Proactive insights API.
 *
 * GET   -> { insights: StoredInsight[] }        (undismissed by default;
 *          ?includeDismissed=1 to include dismissed rows)   [readonly]
 * PATCH -> { id } -> { dismissed: boolean }     (dismiss one insight) [edit]
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listInsights, dismissInsight } from '@/lib/insights';

export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const { searchParams } = new URL(request.url);
        const includeDismissed = searchParams.get('includeDismissed') === '1';

        const insights = await listInsights(bookGuid, { includeDismissed });
        return NextResponse.json({ insights });
    } catch (error) {
        console.error('Error listing insights:', error);
        return NextResponse.json({ error: 'Failed to list insights' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const id = typeof body?.id === 'number' ? body.id : NaN;
        if (!Number.isInteger(id) || id <= 0) {
            return NextResponse.json({ error: 'id (positive integer) is required' }, { status: 400 });
        }

        const dismissed = await dismissInsight(bookGuid, id);
        if (!dismissed) {
            return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
        }
        return NextResponse.json({ dismissed: true });
    } catch (error) {
        console.error('Error dismissing insight:', error);
        return NextResponse.json({ error: 'Failed to dismiss insight' }, { status: 500 });
    }
}
