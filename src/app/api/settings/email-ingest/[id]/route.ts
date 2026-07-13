import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { deleteIngestSender } from '@/lib/email-ingest';

/**
 * DELETE /api/settings/email-ingest/[id] — remove a sender from the
 * allowlist. Users can only delete senders they own.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idRaw } = await params;
    const id = parseInt(idRaw, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Invalid sender id' }, { status: 400 });
    }

    const deleted = await deleteIngestSender(id, roleResult.user.id);
    if (!deleted) {
      return NextResponse.json({ error: 'Sender not found' }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('Error deleting ingest sender:', error);
    return NextResponse.json({ error: 'Failed to delete sender' }, { status: 500 });
  }
}
