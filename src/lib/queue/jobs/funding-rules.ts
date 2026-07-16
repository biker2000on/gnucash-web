import type { Job } from 'bullmq';

/**
 * Budget auto-funding sweep.
 *
 * Every 30 minutes (worker.ts setInterval) — and on demand via the
 * 'funding-rules' job or the page's "Run now" — scan the last few days of
 * deposits for matches against active funding rules and create the envelope
 * sweep transfers.
 *
 * Idempotency: each sweep transaction carries num = 'autofund:<ruleId>:<txGuid>',
 * so re-scanning the same window is a no-op (see funding-rules.service.ts for
 * the full dedupe rationale). Period-locked dates are skipped, and each
 * application notifies the book's edit/admin users (deduped per user via
 * notification source ids).
 *
 * Worker wiring (owned by worker.ts):
 *   case 'funding-rules': { ... }
 *   plus a 30-minute setInterval sweep.
 */
export async function handleFundingRules(job: Job): Promise<void> {
  const { runFundingRules } = await import('@/lib/services/funding-rules.service');

  const { bookGuid, sinceDays } = (job.data ?? {}) as { bookGuid?: string; sinceDays?: number };

  const result = await runFundingRules({ bookGuid, sinceDays });

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`[Job ${job.id}] Funding rules: ${err}`);
    }
  }
  console.log(
    `[Job ${job.id}] Funding rules: ${result.rulesScanned} rule(s), ` +
    `${result.depositsMatched} deposit match(es), ${result.applied} applied, ` +
    `${result.skippedAlreadyApplied} already applied, ${result.skippedLocked} period-locked, ` +
    `${result.errors.length} error(s)`,
  );
}
