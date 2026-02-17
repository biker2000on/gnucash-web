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
}
