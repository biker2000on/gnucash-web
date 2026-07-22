import { Job } from 'bullmq';

export async function handleRefreshPrices(job: Job): Promise<void> {
  console.log(`[Job ${job.id}] Starting price refresh...`);

  // Dynamic imports to avoid pulling in yahoo-finance2 at module load time
  const { fetchAndStorePrices, earliestBackfilledDate } = await import('@/lib/yahoo-price-service');
  const { fetchIndexPrices } = await import('@/lib/market-index-service');

  const { bookGuid, symbols, force } = job.data as {
    userId?: number; // deprecated, kept for backward compat
    bookGuid?: string;
    symbols?: string[];
    force?: boolean;
  };

  const commodityResult = await fetchAndStorePrices(symbols, force ?? false);
  console.log(`[Job ${job.id}] Commodity prices: ${commodityResult.stored} stored, ${commodityResult.failed} failed`);

  // Invalidate dashboard metric caches from the earliest backfilled price
  // date forward (prices affect net-worth/kpis valuations)
  if (bookGuid) {
    try {
      const fromDate = earliestBackfilledDate(commodityResult);
      if (fromDate) {
        const { cacheInvalidateFrom } = await import('@/lib/cache');
        await cacheInvalidateFrom(bookGuid, fromDate);
      }
    } catch (err) {
      // Cache invalidation failure should not fail the job
      console.warn(`[Job ${job.id}] Cache invalidation failed:`, err);
    }
  }

  const indexResult = await fetchIndexPrices();
  console.log(`[Job ${job.id}] Index prices: ${indexResult.map(r => `${r.symbol}: ${r.stored}`).join(', ')}`);

  // NOTE: SimpleFin sync no longer piggybacks on the price refresh — the
  // worker runs it on its own interval timers (recoverSimpleFinSchedules in
  // worker.ts, driven by the simplefin_sync_interval_hours preference).
}
