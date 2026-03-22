import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listReceipts } from '@/lib/receipts';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const search = searchParams.get('search') || undefined;
    const linked = searchParams.get('linked') as 'linked' | 'unlinked' | undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    const result = await listReceipts({
      bookGuid,
      limit,
      offset,
      search,
      linked: linked === 'linked' || linked === 'unlinked' ? linked : undefined,
      startDate,
      endDate,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Receipt list error:', error);
    return NextResponse.json({ error: 'Failed to list receipts' }, { status: 500 });
  }
}
