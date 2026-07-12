import type { Job } from 'bullmq';
import { runAllBackups, runBookBackup } from '@/lib/backup';
import prisma from '@/lib/prisma';

/**
 * Back up one book (job.data.bookGuid) or every book (no data).
 * Scheduled nightly by the worker; also enqueued by the Run-now API.
 */
export async function handleRunBackups(job: Job): Promise<void> {
  const { bookGuid } = (job.data ?? {}) as { bookGuid?: string };

  if (bookGuid) {
    const book = await prisma.books.findUnique({
      where: { guid: bookGuid },
      select: { guid: true, root_account_guid: true },
    });
    if (!book) {
      console.warn(`run-backups: book ${bookGuid} not found`);
      return;
    }
    const result = await runBookBackup(book.guid, book.root_account_guid);
    console.log(`Backup: book ${result.bookGuid} → ${result.storageKey} (${(result.sizeBytes / 1024).toFixed(1)} KiB, pruned ${result.pruned})`);
    return;
  }

  const { results, errors } = await runAllBackups();
  for (const r of results) {
    console.log(`Backup: book ${r.bookGuid} → ${r.storageKey} (${(r.sizeBytes / 1024).toFixed(1)} KiB, pruned ${r.pruned})`);
  }
  for (const e of errors) {
    console.error(`Backup FAILED for book ${e.bookGuid}: ${e.error}`);
  }
}
