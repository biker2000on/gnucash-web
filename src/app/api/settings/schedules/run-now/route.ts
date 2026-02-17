import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { enqueueJob } from '@/lib/queue/queues';

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const jobId = await enqueueJob('refresh-prices');

    if (!jobId) {
      // No Redis configured, run directly
      const { fetchAndStorePrices } = await import('@/lib/yahoo-price-service');
      const result = await fetchAndStorePrices();
      return NextResponse.json({
        success: true,
        message: `Refreshed ${result.stored} prices`,
        stored: result.stored,
        backfilled: result.backfilled,
        gapsFilled: result.gapsFilled,
        failed: result.failed,
        direct: true,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Price refresh job queued',
      jobId,
    });
  } catch (error) {
    console.error('Failed to trigger price refresh:', error);
    return NextResponse.json(
      { error: 'Failed to start price refresh' },
      { status: 500 }
    );
  }
}
