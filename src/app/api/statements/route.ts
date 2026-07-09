import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listBatches } from '@/lib/services/statement.service';

/** GET /api/statements — list statement batches for the active book. */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const batches = await listBatches(bookGuid);
    return NextResponse.json({ batches });
  } catch (error) {
    console.error('Statement list error:', error);
    return NextResponse.json({ error: 'Failed to list statements' }, { status: 500 });
  }
}
