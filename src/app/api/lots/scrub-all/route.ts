import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { scrubAllAccounts } from '@/lib/lot-assignment';
import { getBookAccountGuids } from '@/lib/book-scope';

export async function POST(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const method = body.method || 'fifo';
    const validMethods = ['fifo', 'lifo', 'average'];
    if (!validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(', ')}` },
        { status: 400 }
      );
    }

    const accountGuids = await getBookAccountGuids();
    const result = await scrubAllAccounts(method, accountGuids);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error scrubbing all accounts:', error);
    return NextResponse.json({ error: 'Failed to scrub accounts' }, { status: 500 });
  }
}
