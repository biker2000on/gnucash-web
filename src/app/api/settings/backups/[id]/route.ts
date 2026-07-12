import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBackup, deleteBackup } from '@/lib/backup';

/** GET /api/settings/backups/[id] — download one backup (.gnucash gzip XML). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid backup id' }, { status: 400 });
    }

    const backup = await getBackup(id, roleResult.bookGuid);
    if (!backup) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }

    const stamp = backup.record.createdAt.toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(backup.content), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="backup-${stamp}-${id}.gnucash"`,
      },
    });
  } catch (error) {
    console.error('Error downloading backup:', error);
    return NextResponse.json({ error: 'Failed to download backup' }, { status: 500 });
  }
}

/** DELETE /api/settings/backups/[id] — delete one backup. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (!Number.isInteger(id)) {
      return NextResponse.json({ error: 'Invalid backup id' }, { status: 400 });
    }

    const deleted = await deleteBackup(id, roleResult.bookGuid);
    if (!deleted) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting backup:', error);
    return NextResponse.json({ error: 'Failed to delete backup' }, { status: 500 });
  }
}
