import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { listMappings } from '@/lib/category-mapper';

export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const mappings = await listMappings(bookGuid);
    return NextResponse.json(mappings);
  } catch (error) {
    console.error('List category mappings error:', error);
    return NextResponse.json({ error: 'Failed to list mappings' }, { status: 500 });
  }
}
