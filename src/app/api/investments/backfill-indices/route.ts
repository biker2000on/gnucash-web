import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { backfillIndexPrices } from '@/lib/market-index-service';

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

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
