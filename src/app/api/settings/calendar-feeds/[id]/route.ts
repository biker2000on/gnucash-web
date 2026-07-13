import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { revokeCalendarFeedToken } from '@/lib/calendar-tokens';

/** DELETE /api/settings/calendar-feeds/[id] — revoke a feed token (own feeds only). */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;
        if (roleResult.viaToken) {
            return NextResponse.json({ error: 'API tokens cannot manage calendar feeds' }, { status: 403 });
        }

        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid feed id' }, { status: 400 });
        }

        const revoked = await revokeCalendarFeedToken(roleResult.user.id, id);
        if (!revoked) {
            return NextResponse.json({ error: 'Feed not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error revoking calendar feed:', error);
        return NextResponse.json({ error: 'Failed to revoke calendar feed' }, { status: 500 });
    }
}
