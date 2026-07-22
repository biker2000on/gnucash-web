import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { scrubAllAccounts } from '@/lib/lot-assignment';
import { getBookAccountGuids } from '@/lib/book-scope';
import { jobProgressEmitter } from '@/lib/job-progress';

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user, bookGuid } = roleResult;

    const body = await request.json();
    const method = body.method || 'fifo';
    const clearFirst = body.clearFirst === true;
    const validMethods = ['fifo', 'lifo', 'average'];
    if (!validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(', ')}` },
        { status: 400 }
      );
    }

    // Inline work still streams progress on the job bus (synthetic id).
    const jobId = `inline-${randomUUID()}`;
    const emit = jobProgressEmitter({
      jobId,
      kind: 'scrub-all-lots',
      bookGuid,
      userId: user.id,
      source: 'manual',
      label: 'Scrub all lots',
    });

    const accountGuids = await getBookAccountGuids();
    void emit.running();
    try {
      const result = await scrubAllAccounts(method, accountGuids, clearFirst, (p) =>
        void emit.progress(p),
      );
      void emit.completed({
        accounts: result.order.length,
        lotsCreated: result.results.reduce((s, r) => s + r.lotsCreated, 0),
        gainsTransactions: result.results.reduce((s, r) => s + r.gainsTransactions, 0),
        cleared: result.cleared,
      });
      return NextResponse.json({ ...result, jobId });
    } catch (error) {
      void emit.failed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  } catch (error) {
    console.error('Error scrubbing all accounts:', error);
    return NextResponse.json({ error: 'Failed to scrub accounts' }, { status: 500 });
  }
}
