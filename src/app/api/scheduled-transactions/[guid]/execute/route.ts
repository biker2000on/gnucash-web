import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { executeOccurrence } from '@/lib/services/scheduled-tx-execute';
import { cacheInvalidateFrom } from '@/lib/cache';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    const body = await request.json();
    const { occurrenceDate } = body;

    if (!occurrenceDate || typeof occurrenceDate !== 'string') {
      return NextResponse.json({ error: 'occurrenceDate is required (YYYY-MM-DD)' }, { status: 400 });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
      return NextResponse.json({ error: 'occurrenceDate must be YYYY-MM-DD format' }, { status: 400 });
    }

    // Period lock: executing creates a real transaction dated occurrenceDate
    const lockError = await withPeriodLockCheck(roleResult.bookGuid, [occurrenceDate]);
    if (lockError) return lockError;

    const result = await executeOccurrence(guid, occurrenceDate);

    if (!result.success) {
      const status = result.error?.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    // Invalidate dashboard metric caches from the executed occurrence date forward
    try {
      await cacheInvalidateFrom(roleResult.bookGuid, new Date(occurrenceDate));
    } catch (err) {
      // Cache invalidation failure should not break the execute operation
      console.warn('Cache invalidation failed:', err);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to execute' }, { status: 500 });
  }
}
