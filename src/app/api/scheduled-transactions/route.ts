import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { fetchScheduledTransactions } from '@/lib/scheduled-transactions';
import { createScheduledTransaction, CreateScheduledTxInput } from '@/lib/services/scheduled-tx-create';


/**
 * @openapi
 * /api/scheduled-transactions:
 *   get:
 *     description: Returns all scheduled transactions with resolved template amounts and account mappings.
 *     parameters:
 *       - name: enabled
 *         in: query
 *         description: Filter to only enabled scheduled transactions
 *         schema:
 *           type: string
 *           enum: ['true']
 *     responses:
 *       200:
 *         description: A list of scheduled transactions.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const enabledOnly = request.nextUrl.searchParams.get('enabled') === 'true';
    const scheduledTransactions = await fetchScheduledTransactions(enabledOnly);

    return NextResponse.json(scheduledTransactions);
  } catch (error) {
    console.error('Error fetching scheduled transactions:', error);
    return NextResponse.json(
      { error: 'Failed to fetch scheduled transactions' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body: CreateScheduledTxInput = await request.json();
    const result = await createScheduledTransaction(body);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating scheduled transaction:', error);
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 });
  }
}
