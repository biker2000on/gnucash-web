import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getReceiptsForTransaction } from '@/lib/receipts';

type RouteParams = { params: Promise<{ guid: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { guid } = await params;
    const receipts = await getReceiptsForTransaction(guid, bookGuid);

    return NextResponse.json(receipts);
  } catch (error) {
    console.error('Transaction receipts error:', error);
    return NextResponse.json({ error: 'Failed to get receipts' }, { status: 500 });
  }
}
