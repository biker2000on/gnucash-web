import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getBatch,
  buildReconcileView,
  applyLineDecisions,
  StatementReconcileError,
  type LineDecisionInput,
} from '@/lib/statement-reconcile-data';
import { serializeBigInts } from '@/lib/gnucash';

/**
 * PUT /api/statements/[id]/lines
 *
 * Persist per-line reconcile decisions (edit role).
 *
 * Request body: an array of decisions
 * [
 *   { lineId: number, decision: 'match', matchedSplitGuid: string },
 *   { lineId: number, decision: 'add',   counterpartAccountGuid?: string },
 *   { lineId: number, decision: 'ignore' }
 * ]
 *   • 'match'  → line.match_state='matched', matched_split_guid set.
 *   • 'add'    → line.match_state='added', suggested_account_guid = counterpart
 *                (keeps a prior suggestion when counterpartAccountGuid omitted).
 *   • 'ignore' → line.match_state='ignored'.
 *
 * Response 200:
 * { success: true, updated: number,
 *   errors: [{ lineId, error }],   // per-line validation problems (non-fatal)
 *   tieOut: { expectedChange, actualChange, difference, tiesOut } }  // refreshed
 * 400 { error } — malformed body / invalid id / batch has no account.
 * 403 { error } — batch belongs to another book.
 * 404 { error } — batch not found.
 */
export async function PUT(
  request: NextRequest,
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

    const body = await request.json();
    const decisions: unknown = Array.isArray(body) ? body : body?.decisions;
    if (!Array.isArray(decisions)) {
      return NextResponse.json(
        { error: 'Body must be an array of line decisions' },
        { status: 400 },
      );
    }

    // Validate decision shapes up front.
    const valid: LineDecisionInput[] = [];
    for (const d of decisions as Array<Record<string, unknown>>) {
      const lineId = Number(d.lineId);
      const decision = d.decision;
      if (!Number.isInteger(lineId)) {
        return NextResponse.json({ error: `Invalid lineId: ${String(d.lineId)}` }, { status: 400 });
      }
      if (decision !== 'match' && decision !== 'add' && decision !== 'ignore') {
        return NextResponse.json(
          { error: `Invalid decision for line ${lineId}: ${String(decision)}` },
          { status: 400 },
        );
      }
      valid.push({
        lineId,
        decision,
        matchedSplitGuid: typeof d.matchedSplitGuid === 'string' ? d.matchedSplitGuid : undefined,
        counterpartAccountGuid:
          typeof d.counterpartAccountGuid === 'string' ? d.counterpartAccountGuid : undefined,
      });
    }

    const batch = await getBatch(batchId);
    if (!batch) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }
    if (batch.book_guid !== bookGuid) {
      return NextResponse.json({ error: 'No access to this statement' }, { status: 403 });
    }

    const result = await applyLineDecisions(batchId, valid);

    // Refresh the tie-out so the UI can update immediately.
    let tieOut = null;
    try {
      const view = await buildReconcileView(batch);
      tieOut = view.tieOut;
    } catch {
      // no_account or similar — omit tieOut rather than fail the write.
    }

    return NextResponse.json(
      serializeBigInts({ success: true, updated: result.updated, errors: result.errors, tieOut }),
    );
  } catch (error) {
    if (error instanceof StatementReconcileError) {
      return NextResponse.json({ error: error.message, detail: error.detail }, { status: 400 });
    }
    console.error('Error updating statement lines:', error);
    return NextResponse.json({ error: 'Failed to update statement lines' }, { status: 500 });
  }
}
