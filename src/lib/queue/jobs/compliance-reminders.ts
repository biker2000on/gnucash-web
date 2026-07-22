import type { Job } from 'bullmq';

/**
 * Daily compliance-deadline reminders.
 *
 * For every book: compute the entity's compliance items (current year plus
 * next year, to catch January due dates), keep the ones due within the next
 * 14 days that are still pending (no done/dismissed row in
 * gnucash_web_compliance_status), and create one notification per
 * (user, book, item, period). Deduped via source='compliance' +
 * source_id='compliance:<book>:<key>:<period>' — re-runs never re-notify a
 * (user, deadline) pair that already got a notification, read or not.
 *
 * Worker wiring (owned by worker.ts):
 *   case 'compliance-reminders': { ... }
 * Suggested schedule: daily (setScheduleGeneric('compliance-reminders', '06:15', ...)).
 */

const REMINDER_HORIZON_DAYS = 14;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function handleComplianceReminders(job: Job): Promise<void> {
  const prisma = (await import('@/lib/prisma')).default;
  const { complianceItemsForYear, complianceStatusKey } = await import('@/lib/compliance');
  const { createNotification, ensureNotificationsTable } = await import('@/lib/notifications');
  const { ENTITY_TYPES } = await import('@/lib/services/entity.service');
  type EntityType = (typeof ENTITY_TYPES)[number];

  const { bookGuid } = (job.data ?? {}) as { bookGuid?: string };

  const books = bookGuid
    ? await prisma.books.findMany({ where: { guid: bookGuid }, select: { guid: true } })
    : await prisma.books.findMany({ select: { guid: true } });
  if (books.length === 0) {
    console.log(`[Job ${job.id}] Compliance reminders: no books`);
    return;
  }

  const now = new Date();
  const today = isoDate(now);
  const horizon = isoDate(new Date(now.getTime() + REMINDER_HORIZON_DAYS * 24 * 60 * 60 * 1000));
  const year = now.getFullYear();

  await ensureNotificationsTable();

  let created = 0;
  for (const book of books) {
    try {
      // Entity type/state straight from the profile row; books without a
      // profile default to household with no state (same default the
      // synthesized profile uses).
      const profile = await prisma.gnucash_web_entity_profiles.findUnique({
        where: { book_guid: book.guid },
      });
      const entityType: EntityType =
        profile && (ENTITY_TYPES as readonly string[]).includes(profile.entity_type)
          ? (profile.entity_type as EntityType)
          : 'household';
      const taxState = profile?.tax_state ?? null;
      const businessActivity =
        profile?.business_activity === 'farm' ? ('farm' as const) : ('general' as const);

      const dueSoon = [
        ...complianceItemsForYear(entityType, taxState, year, businessActivity),
        ...complianceItemsForYear(entityType, taxState, year + 1, businessActivity),
      ].filter(i => i.dueDate >= today && i.dueDate <= horizon);
      if (dueSoon.length === 0) continue;

      const statusRows = await prisma.gnucash_web_compliance_status.findMany({
        where: { book_guid: book.guid },
        select: { item_key: true, period: true },
      });
      const resolved = new Set(statusRows.map(r => complianceStatusKey(r.item_key, r.period)));
      const pending = dueSoon.filter(i => !resolved.has(complianceStatusKey(i.key, i.period)));
      if (pending.length === 0) continue;

      // Notify users who can act on the book (edit/admin).
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

      for (const item of pending) {
        const sourceId = `compliance:${book.guid}:${item.key}:${item.period}`;
        for (const userId of userIds) {
          const exists = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id
            FROM gnucash_web_notifications
            WHERE user_id = ${userId}
              AND source = 'compliance'
              AND source_id = ${sourceId}
            LIMIT 1
          `;
          if (exists.length > 0) continue;

          await createNotification({
            userId,
            bookGuid: book.guid,
            type: 'compliance_deadline',
            severity: item.severity === 'payment' ? 'warning' : 'info',
            title: `${item.title} — due ${item.dueDate}`,
            message: item.description,
            href: item.href ?? '/taxes/compliance',
            source: 'compliance',
            sourceId,
          });
          created++;
        }
      }
    } catch (error) {
      console.error(`[Job ${job.id}] Compliance reminders FAILED for book ${book.guid}:`, error);
    }
  }

  console.log(
    `[Job ${job.id}] Compliance reminders: ${books.length} book(s) scanned, ${created} notification(s) created`,
  );
}
