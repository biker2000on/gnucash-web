import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getBatch,
  buildReconcileView,
  StatementReconcileError,
} from '@/lib/statement-reconcile-data';
import { serializeBigInts } from '@/lib/gnucash';

/**
 * GET /api/statements/[id]/reconcile
 *
 * Returns the reconcile view for a statement batch: batch metadata, matched
 * line↔split pairs (explicit + auto-suggested), missing lines needing review
 * (each with a suggested counterpart account), ledger-only splits, and a live
 * tie-out. Read-only (readonly role).
 *
 * Response 200:
 * {
 *   batch: {
 *     id, status, accountGuid, statementStartDate, statementEndDate,
 *     openingBalance, closingBalance, currency, originalFilename
 *   },
 *   matched: [{ lineId, splitGuid, auto,
 *               line: { date, description, amount },
 *               split: { date, description, amount, reconcileState } }],
 *   missing: [{ lineId, date, description, amount,
 *               suggestedAccountGuid, suggestedAccountName, decision }],
 *   inLedgerNotOnStatement: [{ splitGuid, date, description, amount, reconcileState }],
 *   tieOut: { expectedChange, actualChange, difference, tiesOut },
 *   windowDays
 * }
 * 400 { error } — batch has no account assigned.
 * 403 { error } — batch belongs to another book / no access.
 * 404 { error } — batch not found.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const batchId = Number(id);
    if (!Number.isInteger(batchId)) {
      return NextResponse.json({ error: 'Invalid statement id' }, { status: 400 });
    }

    const batch = await getBatch(batchId);
    if (!batch) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }
    if (batch.book_guid !== bookGuid) {
      return NextResponse.json({ error: 'No access to this statement' }, { status: 403 });
    }

    const view = await buildReconcileView(batch);
    return NextResponse.json(serializeBigInts(view));
  } catch (error) {
    if (error instanceof StatementReconcileError) {
      return NextResponse.json(
        { error: error.message, detail: error.detail },
        { status: error.code === 'not_found' ? 404 : 400 },
      );
    }
    console.error('Error building reconcile view:', error);
    return NextResponse.json({ error: 'Failed to build reconcile view' }, { status: 500 });
  }
}
