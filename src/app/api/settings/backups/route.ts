import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listBackups } from '@/lib/backup';
import { enqueueJob } from '@/lib/queue/queues';

/** GET /api/settings/backups — list backups for the active book. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const backups = await listBackups(roleResult.bookGuid);
    return NextResponse.json({
      backups: backups.map(b => ({
        id: b.id,
        sizeBytes: b.sizeBytes,
        createdAt: b.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error listing backups:', error);
    return NextResponse.json({ error: 'Failed to list backups' }, { status: 500 });
  }
}

/** POST /api/settings/backups — run a backup of the active book now. */
export async function POST() {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const jobId = await enqueueJob('run-backups', { bookGuid: roleResult.bookGuid });
    if (jobId === undefined) {
      // Redis unavailable — run inline
      const { handleRunBackups } = await import('@/lib/queue/jobs/run-backups');
      await handleRunBackups({ data: { bookGuid: roleResult.bookGuid } } as Parameters<typeof handleRunBackups>[0]);
      return NextResponse.json({ status: 'completed' });
    }
    return NextResponse.json({ status: 'queued', jobId });
  } catch (error) {
    console.error('Error running backup:', error);
    return NextResponse.json({ error: 'Failed to run backup' }, { status: 500 });
  }
}
