import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { revertScrubRun } from '@/lib/lot-assignment';

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { runId } = body;
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    const result = await revertScrubRun(runId);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error reverting scrub run:', error);
    return NextResponse.json({ error: 'Failed to revert scrub run' }, { status: 500 });
  }
}
