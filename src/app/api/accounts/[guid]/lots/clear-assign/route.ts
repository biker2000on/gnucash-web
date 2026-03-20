import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { clearLotAssignments } from '@/lib/lot-assignment';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ guid: string }> }
) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const { guid: accountGuid } = await params;

    if (!await isAccountInActiveBook(accountGuid)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const result = await clearLotAssignments(accountGuid);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error clearing lot assignments:', error);
    return NextResponse.json(
      { error: 'Failed to clear lot assignments' },
      { status: 500 }
    );
  }
}
