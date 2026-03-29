import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { computeNextOccurrences, RecurrencePattern } from '@/lib/recurrence';
import { fetchScheduledTransactions } from '../route';

interface UpcomingOccurrence {
  date: string;
  scheduledTransactionGuid: string;
  scheduledTransactionName: string;
  splits: Array<{ accountGuid: string; accountName: string; amount: number }>;
}

/**
 * @openapi
 * /api/scheduled-transactions/upcoming:
 *   get:
 *     description: Returns upcoming scheduled transaction occurrences sorted by date.
 *     parameters:
 *       - name: days
 *         in: query
 *         description: Number of days ahead to look (default 30)
 *         schema:
 *           type: integer
 *           default: 30
 *     responses:
 *       200:
 *         description: A list of upcoming occurrences sorted by date.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const daysParam = request.nextUrl.searchParams.get('days');
    const days = daysParam ? parseInt(daysParam, 10) : 30;

    if (isNaN(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { error: 'days must be between 1 and 365' },
        { status: 400 }
      );
    }

    // Fetch all enabled scheduled transactions
    const scheduledTransactions = await fetchScheduledTransactions(true);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + days);

    const occurrences: UpcomingOccurrence[] = [];

    for (const st of scheduledTransactions) {
      if (!st.recurrence) continue;

      const periodStart = new Date(st.recurrence.periodStart);
      const pattern: RecurrencePattern = {
        periodType: st.recurrence.periodType,
        mult: st.recurrence.mult,
        periodStart,
        weekendAdjust: st.recurrence.weekendAdjust,
      };

      const lastOccur = st.lastOccur ? new Date(st.lastOccur) : null;
      const endDate = st.endDate ? new Date(st.endDate) : null;
      // remainingOccurrences: >0 = limited, 0 = exhausted (skip), null/-1 = unlimited
      if (st.remainingOccurrences === 0) continue;
      const remOccur = st.remainingOccurrences > 0 ? st.remainingOccurrences : null;

      const nextDates = computeNextOccurrences(
        pattern,
        lastOccur,
        endDate,
        remOccur,
        10,
        today
      );

      for (const date of nextDates) {
        if (date > windowEnd) break;

        occurrences.push({
          date: date.toISOString().split('T')[0],
          scheduledTransactionGuid: st.guid,
          scheduledTransactionName: st.name,
          splits: st.splits,
        });
      }
    }

    // Sort by date
    occurrences.sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json(occurrences);
  } catch (error) {
    console.error('Error fetching upcoming scheduled transactions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch upcoming scheduled transactions' },
      { status: 500 }
    );
  }
}
