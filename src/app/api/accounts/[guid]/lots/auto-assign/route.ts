import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { autoAssignLots } from '@/lib/lot-assignment';
import { BookBusyError } from '@/lib/book-lock';
import { publishDataChange } from '@/lib/data-events';

const VALID_METHODS = ['fifo', 'lifo', 'average'] as const;

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

    const body = await request.json();
    const method = body.method || 'fifo';

    if (!VALID_METHODS.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${VALID_METHODS.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await autoAssignLots(accountGuid, method, bookGuid);
    void publishDataChange(bookGuid, 'transactions', { action: 'bulk' });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BookBusyError) {
      return NextResponse.json(
        { error: 'Another operation on this book is in progress. Try again shortly.' },
        { status: 409 }
      );
    }
    console.error('Error auto-assigning lots:', error);
    return NextResponse.json(
      { error: 'Failed to auto-assign lots' },
      { status: 500 }
    );
  }
}
