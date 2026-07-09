import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getBatch } from '@/lib/services/statement.service';
import { enqueueExtractStatement } from '@/lib/queue/queues';

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/statements/[id]/parse — re-trigger extraction for a batch. */
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const { id } = await params;
    const batchId = parseInt(id, 10);
    if (isNaN(batchId)) {
      return NextResponse.json({ error: 'Invalid statement ID' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const batch = await getBatch(batchId, bookAccountGuids);
    if (!batch || batch.bookGuid !== bookGuid) {
      return NextResponse.json({ error: 'Statement not found' }, { status: 404 });
    }

    const jobId = await enqueueExtractStatement({ batchId, bookGuid, userId: user.id });
    if (!jobId) {
      // Redis unavailable — run extraction inline.
      try {
        const { runStatementExtraction } = await import('@/lib/statement-ingest');
        await runStatementExtraction(batchId, bookGuid, `[reparse-${batchId}]`, user.id);
      } catch (extractErr) {
        console.error(`Inline statement re-parse failed for batch ${batchId}:`, extractErr);
        return NextResponse.json({ error: 'Extraction failed' }, { status: 500 });
      }
    }

    const updated = await getBatch(batchId, bookAccountGuids);
    return NextResponse.json({ batch: updated, queued: !!jobId });
  } catch (error) {
    console.error('Statement re-parse error:', error);
    return NextResponse.json({ error: 'Failed to re-parse statement' }, { status: 500 });
  }
}
