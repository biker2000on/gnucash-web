import type { Job } from 'bullmq';

/**
 * Run the proactive-insight detectors for every book.
 *
 * Worker wiring (owned by the worker file, not this module):
 *   case 'run-insights': {
 *     const { handleRunInsights } = await import('./src/lib/queue/jobs/run-insights');
 *     await handleRunInsights(job);
 *     break;
 *   }
 * Suggested schedule: daily at 06:00 UTC (setScheduleGeneric('daily-insights', '06:00', ...)).
 *
 * The optional AI polish inside runInsights resolves its provider from the
 * first user's AI config (falling back to env vars); when nothing is
 * configured the deterministic template text is used — the job never fails
 * because AI is absent.
 */
export async function handleRunInsights(job: Job): Promise<void> {
  const prisma = (await import('@/lib/prisma')).default;
  const { runInsights } = await import('@/lib/insights');

  const { bookGuid } = (job.data ?? {}) as { bookGuid?: string };

  const books = bookGuid
    ? await prisma.books.findMany({ where: { guid: bookGuid }, select: { guid: true } })
    : await prisma.books.findMany({ select: { guid: true } });

  if (books.length === 0) {
    console.log(`[Job ${job.id}] Insights: no books to scan`);
    return;
  }

  // AI-polish config source: the first user (getAiConfig falls back to env
  // vars when that user has no DB config).
  const firstUser = await prisma.gnucash_web_users.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const aiUserId = firstUser?.id ?? 0;

  for (const book of books) {
    try {
      const result = await runInsights(book.guid, aiUserId);
      console.log(
        `[Job ${job.id}] Insights: book ${book.guid} — ${result.detected} detected, ${result.created} new`
      );
    } catch (error) {
      console.error(`[Job ${job.id}] Insights FAILED for book ${book.guid}:`, error);
    }
  }
}
