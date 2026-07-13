import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { revokeShareLink } from '@/lib/share-links';

/**
 * DELETE /api/settings/share-links/[id] — revoke a share link (own links only).
 * Revocation only ever narrows access, so 'readonly' suffices.
 */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { id: idParam } = await params;
        const id = parseInt(idParam, 10);
        if (!Number.isInteger(id)) {
            return NextResponse.json({ error: 'Invalid share link id' }, { status: 400 });
        }

        const revoked = await revokeShareLink(roleResult.user.id, id);
        if (!revoked) {
            return NextResponse.json({ error: 'Share link not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error revoking share link:', error);
        return NextResponse.json({ error: 'Failed to revoke share link' }, { status: 500 });
    }
}
