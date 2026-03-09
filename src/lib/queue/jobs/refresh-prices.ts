import { Job } from 'bullmq';

export async function handleRefreshPrices(job: Job): Promise<void> {
  console.log(`[Job ${job.id}] Starting price refresh...`);

  // Dynamic imports to avoid pulling in yahoo-finance2 at module load time
  const { fetchAndStorePrices } = await import('@/lib/yahoo-price-service');
  const { fetchIndexPrices } = await import('@/lib/market-index-service');

  const { userId, symbols, force } = job.data as { userId?: number; bookGuid?: string; symbols?: string[]; force?: boolean };

  const commodityResult = await fetchAndStorePrices(symbols, force ?? false);
  console.log(`[Job ${job.id}] Commodity prices: ${commodityResult.stored} stored, ${commodityResult.failed} failed`);

  const indexResult = await fetchIndexPrices();
  console.log(`[Job ${job.id}] Index prices: ${indexResult.map(r => `${r.symbol}: ${r.stored}`).join(', ')}`);

  // SimpleFin sync (if enabled for this user)
  if (userId) {
    try {
      const { getPreference } = await import('@/lib/user-preferences');
      const syncPref = await getPreference<string>(userId, 'simplefin_sync_with_refresh', 'false');

      if (syncPref === 'true') {
        const prisma = (await import('@/lib/prisma')).default;
        // Query by user_id and sync_enabled — use each connection's own book_guid
        // to avoid mismatch with the schedule's bookGuid (from books.findFirst())
        const connections = await prisma.$queryRaw<{ id: number; book_guid: string }[]>`
          SELECT id, book_guid FROM gnucash_web_simplefin_connections
          WHERE user_id = ${userId} AND sync_enabled = TRUE
        `;

        if (connections.length > 0) {
          const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');
          for (const conn of connections) {
            const result = await syncSimpleFin(conn.id, conn.book_guid);
            console.log(`[Job ${job.id}] SimpleFin sync (connection ${conn.id}): ${result.transactionsImported} imported, ${result.transactionsSkipped} skipped`);
          }
        } else {
          console.log(`[Job ${job.id}] SimpleFin sync: no enabled connections found for user ${userId}`);
        }
      } else {
        console.log(`[Job ${job.id}] SimpleFin sync: preference not enabled for user ${userId}`);
      }
    } catch (err) {
      console.error(`[Job ${job.id}] SimpleFin sync failed:`, err);
      // Don't rethrow - price refresh succeeded, SimpleFin sync is secondary
    }
  } else {
    console.log(`[Job ${job.id}] SimpleFin sync: no userId in job data, skipping`);
  }
}
