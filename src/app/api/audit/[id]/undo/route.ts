import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getActiveBookGuid } from '@/lib/book-scope';
import { undoAuditEntry } from '@/lib/services/audit.service';

/**
 * POST /api/audit/[id]/undo — undo one audit entry (transactions only):
 * restore a deleted transaction, revert an update, or delete a creation.
 * The undo is itself logged as a new audit entry. Auth: edit.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid audit id' }, { status: 400 });
    }

    const bookGuid = await getActiveBookGuid();
    const result = await undoAuditEntry(id, bookGuid);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 409 });
    }
    return NextResponse.json({ success: true, message: result.message });
  } catch (error) {
    console.error('Error undoing audit entry:', error);
    return NextResponse.json({ error: 'Failed to undo' }, { status: 500 });
  }
}
