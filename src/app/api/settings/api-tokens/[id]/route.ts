import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { revokeToken } from '@/lib/api-tokens';

/** DELETE /api/settings/api-tokens/[id] — revoke a token (own tokens only). */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    if (roleResult.viaToken) {
      return NextResponse.json({ error: 'API tokens cannot manage API tokens' }, { status: 403 });
    }

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid token id' }, { status: 400 });
    }

    const revoked = await revokeToken(roleResult.user.id, id);
    if (!revoked) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error revoking API token:', error);
    return NextResponse.json({ error: 'Failed to revoke API token' }, { status: 500 });
  }
}
