import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { backfillIndexPrices } from '@/lib/market-index-service';

export async function POST() {
  try {
    const roleResult = await requireRole('admin');
    if (roleResult instanceof NextResponse) return roleResult;

    const results = await backfillIndexPrices();
    const totalStored = results.reduce((sum, r) => sum + r.stored, 0);

    return NextResponse.json({
      success: true,
      totalStored,
      results,
    });
  } catch (error) {
    console.error('Index backfill failed:', error);
    return NextResponse.json(
      { error: 'Failed to backfill index prices' },
      { status: 500 }
    );
  }
}
