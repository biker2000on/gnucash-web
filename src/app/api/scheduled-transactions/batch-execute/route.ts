import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { batchExecuteSkip, BatchItem } from '@/lib/services/scheduled-tx-execute';
import { cacheInvalidateFrom } from '@/lib/cache';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import { fetchScheduledTransactions } from '@/lib/scheduled-transactions';
import { getAccountGuidsForBook } from '@/lib/book-scope';

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const { items } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required and must not be empty' }, { status: 400 });
    }

    for (const item of items) {
      if (!item.guid || !item.occurrenceDate || !['execute', 'skip'].includes(item.action)) {
        return NextResponse.json({
          error: 'Each item must have guid, occurrenceDate (YYYY-MM-DD), and action (execute|skip)',
        }, { status: 400 });
      }
    }
    const [scheduled, bookAccountGuids] = await Promise.all([
      fetchScheduledTransactions(),
      getAccountGuidsForBook(roleResult.bookGuid),
    ]);
    const scopedAccounts = new Set(bookAccountGuids);
    const allowedGuids = new Set(scheduled
      .filter(transaction =>
        transaction.splits.length > 0 &&
        transaction.splits.every(split => scopedAccounts.has(split.accountGuid)))
      .map(transaction => transaction.guid));
    if ((items as BatchItem[]).some(item => !allowedGuids.has(item.guid))) {
      return NextResponse.json({ error: 'One or more scheduled transactions were not found' }, { status: 404 });
    }

    // Period lock: 'execute' items create real transactions dated at their
    // occurrence date (skips only advance metadata and stay allowed).
    const lockError = await withPeriodLockCheck(
      roleResult.bookGuid,
      (items as BatchItem[]).filter(i => i.action === 'execute').map(i => i.occurrenceDate),
    );
    if (lockError) return lockError;

    const result = await batchExecuteSkip(items as BatchItem[]);

    // Invalidate dashboard metric caches from the earliest successfully
    // executed occurrence date forward (skips create no transactions).
    const executedDates = result.results
      .filter(r => r.action === 'execute' && r.success)
      .map(r => r.occurrenceDate)
      .sort();
    if (executedDates.length > 0) {
      try {
        await cacheInvalidateFrom(roleResult.bookGuid, new Date(executedDates[0]));
      } catch (err) {
        // Cache invalidation failure should not break the batch operation
        console.warn('Cache invalidation failed:', err);
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error batch executing:', error);
    return NextResponse.json({ error: 'Failed to batch execute' }, { status: 500 });
  }
}
