import { Job } from 'bullmq';

/**
 * Check all enabled price alerts against the latest stored prices and
 * notify users whose thresholds were crossed. Intended to run after the
 * daily price refresh (worker case name: 'check-price-alerts').
 */
export async function handleCheckPriceAlerts(job: Job): Promise<void> {
  const { checkPriceAlerts } = await import('@/lib/price-alerts');

  const result = await checkPriceAlerts();
  console.log(
    `[Job ${job.id}] Price alerts — ${result.checked} checked, ${result.triggered} triggered`,
  );
}
