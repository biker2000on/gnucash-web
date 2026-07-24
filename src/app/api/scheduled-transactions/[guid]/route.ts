import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  updateScheduledTransaction,
  type CreateScheduledTxInput,
} from '@/lib/services/scheduled-tx-create';

/**
 * PATCH /api/scheduled-transactions/[guid]
 *
 * Replaces the editable schedule definition while preserving the scheduled
 * action GUID, occurrence history, enabled state, and GnuCash template root.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ guid: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { guid } = await params;
    if (!/^[0-9a-f]{32}$/.test(guid)) {
      return NextResponse.json({ error: 'Invalid scheduled transaction GUID' }, { status: 400 });
    }
    const input = await request.json() as CreateScheduledTxInput;
    const result = await updateScheduledTransaction(guid, input, { bookGuid: roleResult.bookGuid });
    if (!result.success) {
      const status = result.error === 'Scheduled transaction not found' ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error updating scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to update scheduled transaction' }, { status: 500 });
  }
}
