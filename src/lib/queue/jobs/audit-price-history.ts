import { Job } from 'bullmq';

export async function handleAuditPriceHistory(job: Job): Promise<void> {
  const { symbols } = job.data as { symbols?: string[] };

  console.log(`[Job ${job.id}] Starting price audit${symbols?.length ? ` for ${symbols.join(', ')}` : ''}...`);

  const { auditAndBackfillPrices } = await import('@/lib/yahoo-price-service');
  const result = await auditAndBackfillPrices(symbols);

  console.log(
    `[Job ${job.id}] Price audit complete: ${result.stored} prices stored across ${result.audited} commodities, ${result.failed} failed`
  );
}
