import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { enqueueJob } from '@/lib/queue/queues';

/**
 * POST /api/simplefin/schedule — signal the worker to rebuild its SimpleFin
 * interval timers after the sync toggle or `simplefin_sync_interval_hours`
 * preference changed. The worker also recovers schedules on startup, so this
 * is a fast-apply nicety, not a correctness requirement.
 */
export async function POST() {
  try {
    // Same gate as the preference write this follows — the signal is an
    // idempotent timer rebuild, not a privileged operation.
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const jobId = await enqueueJob('simplefin-schedule-changed', { bookGuid });
    return NextResponse.json({ ok: true, signaled: !!jobId });
  } catch (error) {
    console.error('Error signaling SimpleFin schedule change:', error);
    return NextResponse.json({ error: 'Failed to signal schedule change' }, { status: 500 });
  }
}
