import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import {
  getBatch,
  setBatchStatus,
  upsertStatementAcctMap,
} from '@/lib/services/statement.service';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * PUT /api/statements/[id]/account — assign (or reassign) the ledger account
 * a statement batch reconciles against. Body: { accountGuid: string }.
 *
 * Used for parsed-but-unassigned batches (e.g. an OFX upload whose <ACCTID>
 * had no remembered mapping). When the batch carries an ofx_acct_id, the
 * pairing is remembered so future uploads auto-assign.
 *
 * Response 200: { batch }
 * 400 { error } — invalid id / missing accountGuid / account not in book /
 *                 batch already reconciled.
 * 404 { error } — batch not found (or belongs to another book).
 */
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const batchId = parseInt(id, 10);
    if (isNaN(batchId)) {
      return NextResponse.json({ error: 'Invalid statement ID' }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const accountGuid =
      body && typeof (body as Record<string, unknown>).accountGuid === 'string'
        ? ((body as Record<string, unknown>).accountGuid as string).trim()
        : '';
    if (!accountGuid) {
      return NextResponse.json({ error: 'accountGuid is required' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    if (!bookAccountGuids.includes(accountGuid)) {
      return NextResponse.json(
        { error: 'accountGuid is not in the active book' },
        { status: 400 },
      );
    }

    const batch = await getBatch(batchId, bookAccountGuids);
    if (!batch || batch.bookGuid !== bookGuid) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }
    if (batch.status === 'reconciled') {
      return NextResponse.json(
        { error: 'Cannot change the account of a reconciled statement' },
        { status: 400 },
      );
    }

    const updated = await setBatchStatus(batchId, batch.status, { accountGuid });

    // Remember the OFX pairing so future uploads of this account auto-assign.
    if (batch.ofxAcctId) {
      try {
        await upsertStatementAcctMap(bookGuid, batch.ofxAcctId, accountGuid);
      } catch (mapErr) {
        console.warn('Failed to upsert OFX account map:', mapErr);
      }
    }

    return NextResponse.json({ batch: updated });
  } catch (error) {
    console.error('Statement account assign error:', error);
    return NextResponse.json({ error: 'Failed to assign account' }, { status: 500 });
  }
}
