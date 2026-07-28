import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { executeOccurrence } from '@/lib/services/scheduled-tx-execute';
import { cacheInvalidateFrom } from '@/lib/cache';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import { isScheduledTransactionInBook } from '@/lib/services/scheduled-tx-create';
import { publishDataChange } from '@/lib/data-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid } = await params;
    if (!await isScheduledTransactionInBook(guid, roleResult.bookGuid)) {
      return NextResponse.json({ error: 'Scheduled transaction not found' }, { status: 404 });
    }
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
      // 409: someone (or another tab) already recorded/skipped this occurrence.
      const status = result.code === 'already_executed'
        ? 409
        : result.error?.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }

    // Invalidate dashboard metric caches from the executed occurrence date forward
    try {
      await cacheInvalidateFrom(roleResult.bookGuid, new Date(occurrenceDate));
    } catch (err) {
      // Cache invalidation failure should not break the execute operation
      console.warn('Cache invalidation failed:', err);
    }

    void publishDataChange(roleResult.bookGuid, 'schedules', { guid, action: 'update' });
    void publishDataChange(roleResult.bookGuid, 'transactions', { action: 'create' });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error executing scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to execute' }, { status: 500 });
  }
}
