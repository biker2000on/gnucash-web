import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { enqueueJob } from '@/lib/queue/queues';

// POST /api/simplefin/sync -- trigger manual sync
export async function POST() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const { user, bookGuid } = roleResult;

    // Get connection for this book
    const connections = await prisma.$queryRaw<{
      id: number;
    }[]>`
      SELECT id FROM gnucash_web_simplefin_connections
      WHERE user_id = ${user.id} AND book_guid = ${bookGuid}
    `;

    if (connections.length === 0) {
      return NextResponse.json({ error: 'No SimpleFin connection found' }, { status: 404 });
    }

    const connectionId = connections[0].id;

    // Try to enqueue via Redis worker
    const jobId = await enqueueJob('sync-simplefin', { connectionId, bookGuid });

    if (!jobId) {
      // No Redis configured, run sync directly
      const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');
      const result = await syncSimpleFin(connectionId, bookGuid);
      return NextResponse.json({
        success: true,
        direct: true,
        ...result,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'SimpleFin sync job queued',
      jobId,
    });
  } catch (error) {
    console.error('Error triggering SimpleFin sync:', error);
    return NextResponse.json({ error: 'Failed to start sync' }, { status: 500 });
  }
}
