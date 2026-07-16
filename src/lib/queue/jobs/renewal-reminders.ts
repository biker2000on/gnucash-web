import type { Job } from 'bullmq';

/**
 * Daily renewal reminders.
 *
 * For every book: find renewals whose date is within remind_days (including
 * overdue ones) that aren't dismissed through today, and create one
 * notification per (user, renewal, cycle). Deduped via source='renewals' +
 * source_id='renewal:<id>:<renewal_date>' — marking a renewal renewed moves
 * the date, which changes the source id, so the next cycle notifies afresh
 * while re-runs within a cycle stay silent.
 *
 * Worker wiring (owned by worker.ts):
 *   case 'renewal-reminders': { ... }
 * Suggested schedule: daily (setScheduleGeneric('renewal-reminders', '06:45', ...)).
 */
export async function handleRenewalReminders(job: Job): Promise<void> {
  const prisma = (await import('@/lib/prisma')).default;
  const { listRenewals, isReminderDue, daysUntil, renewalReminderSourceId, todayIso } =
    await import('@/lib/services/renewals.service');
  const { createNotification, ensureNotificationsTable } = await import('@/lib/notifications');

  const { bookGuid } = (job.data ?? {}) as { bookGuid?: string };

  const books = bookGuid
    ? await prisma.books.findMany({ where: { guid: bookGuid }, select: { guid: true } })
    : await prisma.books.findMany({ select: { guid: true } });
  if (books.length === 0) {
    console.log(`[Job ${job.id}] Renewal reminders: no books`);
    return;
  }

  const today = todayIso();
  await ensureNotificationsTable();

  let created = 0;
  for (const book of books) {
    try {
      const renewals = await listRenewals(book.guid);
      const due = renewals.filter(r => isReminderDue(r, today));
      if (due.length === 0) continue;

      const permissions = await prisma.gnucash_web_book_permissions.findMany({
        where: { book_guid: book.guid },
        include: { role: true },
      });
      const userIds = [...new Set(
        permissions
          .filter(p => p.role.name === 'edit' || p.role.name === 'admin')
          .map(p => p.user_id),
      )];
      if (userIds.length === 0) continue;

      for (const renewal of due) {
        const days = daysUntil(renewal.renewalDate, today);
        const sourceId = renewalReminderSourceId(renewal.id, renewal.renewalDate);
        const when = days < 0
          ? `was due ${renewal.renewalDate} (${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago)`
          : days === 0
            ? 'renews today'
            : `renews ${renewal.renewalDate} (in ${days} day${days === 1 ? '' : 's'})`;

        for (const userId of userIds) {
          const exists = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id
            FROM gnucash_web_notifications
            WHERE user_id = ${userId}
              AND source = 'renewals'
              AND source_id = ${sourceId}
            LIMIT 1
          `;
          if (exists.length > 0) continue;

          await createNotification({
            userId,
            bookGuid: book.guid,
            type: 'renewal_reminder',
            severity: days <= 0 ? 'warning' : 'info',
            title: `${renewal.name} ${when}`,
            message: renewal.amount != null
              ? `Expected amount ${renewal.amount.toFixed(2)}. Mark it renewed or dismiss the reminder on the Renewals page.`
              : 'Mark it renewed or dismiss the reminder on the Renewals page.',
            href: '/tools/renewals',
            source: 'renewals',
            sourceId,
          });
          created++;
        }
      }
    } catch (error) {
      console.error(`[Job ${job.id}] Renewal reminders FAILED for book ${book.guid}:`, error);
    }
  }

  console.log(
    `[Job ${job.id}] Renewal reminders: ${books.length} book(s) scanned, ${created} notification(s) created`,
  );
}
