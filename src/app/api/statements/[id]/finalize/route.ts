import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getBatch,
  finalizeReconcile,
  StatementReconcileError,
} from '@/lib/statement-reconcile-data';
import { PeriodLockedError, periodLockedResponse } from '@/lib/services/period-lock.service';
import { serializeBigInts } from '@/lib/gnucash';

/**
 * POST /api/statements/[id]/finalize
 *
 * Commit the reconcile (edit role). Acts on persisted per-line decisions:
 *   • 'added' lines  → create a balanced 2-split transaction (statement account
 *                       + chosen counterpart) dated at the line date.
 *   • 'matched' lines → nothing created.
 * Then marks every matched/newly-added statement-account split
 * reconcile_state='y' (reconcile_date = statement_end_date) and flips the batch
 * status to 'reconciled'. Runs in one DB transaction.
 *
 * REQUIRES the tie-out to pass. No request body.
 *
 * Response 200:
 * { success: true,
 *   summary: { added, matched, reconciledSplits,
 *              tieOut: { expectedChange, actualChange, difference, tiesOut } } }
 * 409 { error, tieOut } — tie-out failed (difference reported) OR unverifiable
 *                          (opening/closing balance missing).
 * 400 { error, detail } — batch/account misconfigured (no account, no currency,
 *                          an 'add' line without a counterpart account).
 * 403 { error } — batch belongs to another book.
 * 404 { error } — batch not found.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const roleResult = await requireRole('edit');
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

    const summary = await finalizeReconcile(batch);

    // Remember the OFX <ACCTID> → account pairing so future uploads of this
    // account auto-assign. Best effort — never fails the finalize.
    try {
      const { getBatch: getServiceBatch, upsertStatementAcctMap } = await import(
        '@/lib/services/statement.service'
      );
      const full = await getServiceBatch(batchId);
      if (full?.ofxAcctId && full.accountGuid) {
        await upsertStatementAcctMap(bookGuid, full.ofxAcctId, full.accountGuid);
      }
    } catch (mapErr) {
      console.warn('Failed to upsert OFX account map after finalize:', mapErr);
    }

    return NextResponse.json(serializeBigInts({ success: true, summary }));
  } catch (error) {
    if (error instanceof PeriodLockedError) return periodLockedResponse(error);
    if (error instanceof StatementReconcileError) {
      const status = error.code === 'not_ties_out' ? 409 : error.code === 'not_found' ? 404 : 400;
      return NextResponse.json(
        { error: error.message, tieOut: error.code === 'not_ties_out' ? error.detail : undefined, detail: error.detail },
        { status },
      );
    }
    console.error('Error finalizing reconcile:', error);
    return NextResponse.json({ error: 'Failed to finalize reconcile' }, { status: 500 });
  }
}
