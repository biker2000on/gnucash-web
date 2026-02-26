import { Job } from 'bullmq';

export async function handleRefreshPrices(job: Job): Promise<void> {
  console.log(`[Job ${job.id}] Starting price refresh...`);

  // Dynamic imports to avoid pulling in yahoo-finance2 at module load time
  const { fetchAndStorePrices } = await import('@/lib/yahoo-price-service');
  const { fetchIndexPrices } = await import('@/lib/market-index-service');

  const commodityResult = await fetchAndStorePrices();
  console.log(`[Job ${job.id}] Commodity prices: ${commodityResult.stored} stored, ${commodityResult.failed} failed`);

  const indexResult = await fetchIndexPrices();
  console.log(`[Job ${job.id}] Index prices: ${indexResult.map(r => `${r.symbol}: ${r.stored}`).join(', ')}`);

  // SimpleFin sync (if enabled for this user/book)
  const { userId, bookGuid } = job.data as { userId?: number; bookGuid?: string };
  if (userId && bookGuid) {
    try {
      const { getPreference } = await import('@/lib/user-preferences');
      const syncPref = await getPreference<string>(userId, 'simplefin_sync_with_refresh', 'false');

      if (syncPref === 'true') {
        const prisma = (await import('@/lib/prisma')).default;
        const connections = await prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM gnucash_web_simplefin_connections
          WHERE user_id = ${userId} AND book_guid = ${bookGuid}
        `;

        if (connections.length > 0) {
          const { syncSimpleFin } = await import('@/lib/services/simplefin-sync.service');
          const result = await syncSimpleFin(connections[0].id, bookGuid);
          console.log(`[Job ${job.id}] SimpleFin sync: ${result.transactionsImported} imported, ${result.transactionsSkipped} skipped`);
        } else {
          console.log(`[Job ${job.id}] SimpleFin sync: no connections found for user ${userId}`);
        }
      }
    } catch (err) {
      console.error(`[Job ${job.id}] SimpleFin sync failed:`, err);
      // Don't rethrow - price refresh succeeded, SimpleFin sync is secondary
    }
  }
}
