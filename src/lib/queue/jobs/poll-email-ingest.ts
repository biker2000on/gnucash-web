import type { Job } from 'bullmq';
import { isEmailIngestConfigured, pollEmailIngest } from '@/lib/email-ingest';

/**
 * Poll the email-ingest mailbox once: fetch UNSEEN messages and feed
 * allowlisted senders' attachments into the document intake pipelines.
 *
 * Enqueued by the Settings "Poll now" button and by the worker's recurring
 * timer. Suggested worker wiring (worker.ts):
 *
 *   case 'poll-email-ingest': {
 *     const { handlePollEmailIngest } = await import('./src/lib/queue/jobs/poll-email-ingest');
 *     await handlePollEmailIngest(job);
 *     break;
 *   }
 *
 * setScheduleGeneric is daily-only, so for the ~15-minute cadence use a plain
 * interval in worker.ts main(), guarded by isEmailIngestConfigured().
 */
export async function handlePollEmailIngest(job: Job): Promise<void> {
  if (!isEmailIngestConfigured()) {
    console.log(`[${job.id}] Email ingest is not configured (INGEST_IMAP_* unset); skipping poll`);
    return;
  }

  const result = await pollEmailIngest();
  console.log(
    `[${job.id}] Email ingest poll: ${result.checked} message(s) checked, ` +
    `${result.ingested} document(s) ingested, ${result.skipped} skipped, ${result.errors} error(s)`,
  );
}
