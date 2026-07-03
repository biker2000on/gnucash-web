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

  // SimpleFin sync — find enabled connections for this book
  if (bookGuid) {
    try {
      const prisma = (await import('@/lib/prisma')).default;

      // Check if any user with a connection for this book has sync-with-refresh enabled
      const connections = await prisma.gnucash_web_simplefin_connections.findMany({
        where: { book_guid: bookGuid, sync_enabled: true },
        select: { id: true, book_guid: true, user_id: true },
      });

      if (connections.length > 0) {
        // Check if the connection's owner has the sync preference enabled
        const { getPreference } = await import('@/lib/user-preferences');
        const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');

        for (const conn of connections) {
          const syncPref = await getPreference<string>(conn.user_id, 'simplefin_sync_with_refresh', 'false');
          if (syncPref !== 'true') {
            console.log(`[Job ${job.id}] SimpleFin sync: preference not enabled for connection ${conn.id} (user ${conn.user_id})`);
            continue;
          }
          const result = await syncSimpleFin(conn.id, conn.book_guid, { source: 'refresh' });
          console.log(`[Job ${job.id}] SimpleFin sync (connection ${conn.id}): ${result.status}, ${result.transactionsImported} imported, ${result.transactionsSkipped} skipped`);
          if (result.warnings.length > 0) {
            console.warn(`[Job ${job.id}] SimpleFin sync warnings (connection ${conn.id}):`, result.warnings);
          }
          if (result.errors.length > 0) {
            console.error(`[Job ${job.id}] SimpleFin sync errors (connection ${conn.id}):`, result.errors);
          }
        }
      } else {
        console.log(`[Job ${job.id}] SimpleFin sync: no enabled connections for book ${bookGuid}`);
      }
    } catch (err) {
      console.error(`[Job ${job.id}] SimpleFin sync failed:`, err);
      // Don't rethrow - price refresh succeeded, SimpleFin sync is secondary
    }
  } else {
    console.log(`[Job ${job.id}] SimpleFin sync: no bookGuid in job data, skipping`);
  }
}
