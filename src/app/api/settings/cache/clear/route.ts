import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { cacheClearAll } from '@/lib/cache';

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

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
