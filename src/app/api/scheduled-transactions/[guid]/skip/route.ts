import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { skipOccurrence } from '@/lib/services/scheduled-tx-execute';
import { isScheduledTransactionInBook } from '@/lib/services/scheduled-tx-create';

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

    const result = await skipOccurrence(guid, occurrenceDate);

    if (!result.success) {
      const status = result.error?.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error skipping scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to skip' }, { status: 500 });
  }
}
