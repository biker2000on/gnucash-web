import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { cacheClearAll } from '@/lib/cache';

export async function POST() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const deleted = await cacheClearAll();

    return NextResponse.json({
      success: true,
      deleted,
      message: deleted > 0 ? `Cleared ${deleted} cache entries` : 'No cache entries to clear',
    });
  } catch (error) {
    console.error('Failed to clear cache:', error);
    return NextResponse.json(
      { error: 'Failed to clear cache' },
      { status: 500 }
    );
  }
}
