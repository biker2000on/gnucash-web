import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getJobQueue } from '@/lib/queue/queues';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/jobs/[id] — BullMQ job status for SSE-reconnect catch-up and the
 * no-Redis/no-SSE polling fallback.
 *
 * Only jobs belonging to the requester's active book are visible; everything
 * else (including inline-* synthetic ids, which have no queue entry) is 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const queue = getJobQueue();
    if (!queue) {
      return NextResponse.json({ error: 'Job queue unavailable' }, { status: 503 });
    }

    const job = await queue.getJob(id);
    const jobBook = (job?.data as Record<string, unknown> | undefined)?.bookGuid;
    if (!job || jobBook !== bookGuid) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const state = await job.getState();
    return NextResponse.json({
      id: job.id,
      name: job.name,
      state,
      progress: job.progress,
      returnvalue: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn ?? null,
    });
  } catch (error) {
    console.error('Error fetching job status:', error);
    return NextResponse.json({ error: 'Failed to fetch job status' }, { status: 500 });
  }
}
