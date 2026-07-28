import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { clearLotAssignments } from '@/lib/lot-assignment';
import { BookBusyError } from '@/lib/book-lock';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const result = await clearLotAssignments(accountGuid, bookGuid);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BookBusyError) {
      return NextResponse.json(
        { error: 'Another operation on this book is in progress. Try again shortly.' },
        { status: 409 }
      );
    }
    console.error('Error clearing lot assignments:', error);
    return NextResponse.json(
      { error: 'Failed to clear lot assignments' },
      { status: 500 }
    );
  }
}
