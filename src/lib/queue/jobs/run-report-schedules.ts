import type { Job } from 'bullmq';
import { dueSchedules, runReportSchedule } from '@/lib/report-scheduler';

/**
 * Run every due report schedule (or a single one via job.data.scheduleId).
 *
 * Fired daily by the worker's generic schedule; running it more often is safe
 * because runReportSchedule is idempotent per cadence period (it stamps
 * last_run_period with the occurrence key and skips repeats).
 *
 * Worker wiring (worker.ts):
 *   case 'run-report-schedules': {
 *     const { handleRunReportSchedules } = await import('./src/lib/queue/jobs/run-report-schedules');
 *     await handleRunReportSchedules(job);
 *     break;
 *   }
 */
export async function handleRunReportSchedules(job: Job): Promise<void> {
  const { scheduleId } = (job.data ?? {}) as { scheduleId?: number };
  const now = new Date();

  const due = await dueSchedules(now);
  const targets = scheduleId != null ? due.filter(s => s.id === scheduleId) : due;

  if (targets.length === 0) {
    console.log('run-report-schedules: no schedules due');
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const schedule of targets) {
    try {
      const result = await runReportSchedule(schedule, { now });
      if (result.status === 'sent') sent++;
      else if (result.status === 'skipped') skipped++;
      else failed++;
      console.log(
        `Report schedule #${schedule.id} (${schedule.cadence}, user ${schedule.userId}): ` +
        `${result.status}${result.detail ? ` — ${result.detail}` : ''}` +
        `${result.recipients ? ` → ${result.recipients.join(', ')}` : ''}`,
      );
    } catch (err) {
      failed++;
      console.error(`Report schedule #${schedule.id} FAILED:`, err);
    }
  }
  console.log(`run-report-schedules: ${sent} sent, ${skipped} skipped, ${failed} failed (of ${targets.length} due)`);
}
