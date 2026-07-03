import { Job } from 'bullmq';

/**
 * Check IRS contribution-limit coverage for the current (and, from November,
 * next) tax year, and notify editors/admins when limits are missing.
 * Scheduled weekly by the worker; also runs once at worker startup.
 */
export async function handleCheckLimitCoverage(job: Job): Promise<void> {
  const { notifyMissingLimitCoverage } = await import('@/lib/services/limit-coverage.service');

  const result = await notifyMissingLimitCoverage();
  const summary = result.checked
    .map(c => `${c.year}: ${c.missingTypes.length === 0 ? 'ok' : `missing ${c.missingTypes.join(', ')}`}`)
    .join('; ');
  console.log(`[Job ${job.id}] Limit coverage — ${summary} (${result.notified} notification(s) created)`);
}
