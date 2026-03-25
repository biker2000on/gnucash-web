import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { enqueueJob } from '@/lib/queue/queues';

/**
 * GET /api/receipts/regenerate-thumbnails
 * Check if the current user has admin access for this action.
 */
export async function GET() {
  const roleResult = await requireRole('admin');
  if (roleResult instanceof NextResponse) return roleResult;
  return NextResponse.json({ allowed: true });
}

/**
 * POST /api/receipts/regenerate-thumbnails
 * Enqueue a job to regenerate missing or placeholder thumbnails.
 * Requires admin role.
 */
export async function POST() {
  const roleResult = await requireRole('admin');
  if (roleResult instanceof NextResponse) return roleResult;

  try {
    await enqueueJob('regenerate-thumbnails', {});
    return NextResponse.json({ message: 'Thumbnail regeneration job enqueued' });
  } catch (error) {
    console.error('Failed to enqueue thumbnail regeneration:', error);
    return NextResponse.json(
      { error: 'Failed to enqueue job' },
      { status: 500 }
    );
  }
}
