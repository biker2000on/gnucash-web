import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids, isAccountInActiveBook } from '@/lib/book-scope';
import { revertScrubRun, ScrubRunNotInBookError } from '@/lib/lot-assignment';
import { BookBusyError } from '@/lib/book-lock';
import {
  ReconciledSplitError,
  reconciledSplitResponse,
} from '@/lib/services/reconciled-split.service';
import { publishDataChange } from '@/lib/data-events';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    // Book-scope the route like its sibling lot routes: the account in the
    // URL must belong to the caller's active book.
    const { guid: accountGuid } = await params;
    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = await request.json();
    const { runId } = body;
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    // revertScrubRun additionally verifies that every account the run
    // touched is inside the active book before deleting anything.
    const allowedAccountGuids = await getBookAccountGuids();
    const result = await revertScrubRun(runId, { bookGuid, allowedAccountGuids });
    void publishDataChange(bookGuid, 'transactions', { action: 'bulk' });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReconciledSplitError) {
      return reconciledSplitResponse(error);
    }
    if (error instanceof BookBusyError) {
      return NextResponse.json(
        { error: 'Another operation on this book is in progress. Try again shortly.' },
        { status: 409 }
      );
    }
    if (error instanceof ScrubRunNotInBookError) {
      return NextResponse.json({ error: 'Scrub run not found' }, { status: 404 });
    }
    console.error('Error reverting scrub run:', error);
    return NextResponse.json({ error: 'Failed to revert scrub run' }, { status: 500 });
  }
}
