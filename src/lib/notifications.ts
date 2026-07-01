import prisma from '@/lib/prisma';
import { getRedis } from '@/lib/redis';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface AppNotification {
  id: number;
  userId: number;
  bookGuid: string | null;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string | null;
  href: string | null;
  source: string | null;
  sourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

interface CreateNotificationInput {
  userId: number;
  bookGuid?: string | null;
  type?: string;
  severity?: NotificationSeverity;
  title: string;
  message?: string | null;
  href?: string | null;
  source?: string | null;
  sourceId?: string | null;
}

let ensurePromise: Promise<void> | null = null;

export function ensureNotificationsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_notifications_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            book_guid VARCHAR(32),
            type VARCHAR(50) NOT NULL DEFAULT 'background_job',
            severity VARCHAR(20) NOT NULL DEFAULT 'info',
            title VARCHAR(255) NOT NULL,
            message TEXT,
            href TEXT,
            source VARCHAR(100),
            source_id VARCHAR(255),
            read_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_notifications_user_created
            ON gnucash_web_notifications(user_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
            ON gnucash_web_notifications(user_id, read_at)
            WHERE read_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_notifications_user_book
            ON gnucash_web_notifications(user_id, book_guid, created_at DESC);
        END $$;
      `);
    })();
  }
  return ensurePromise;
}

function serializeNotification(notification: AppNotification) {
  return {
    ...notification,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

function notificationChannels(userId: number, bookGuid?: string | null) {
  const channels = [`notifications:user:${userId}`];
  if (bookGuid) channels.push(`notifications:user:${userId}:book:${bookGuid}`);
  return channels;
}

function publishChannels(userId: number, bookGuid?: string | null) {
  return bookGuid
    ? [`notifications:user:${userId}:book:${bookGuid}`]
    : [`notifications:user:${userId}`];
}

async function publishNotification(notification: AppNotification) {
  const redis = getRedis();
  if (!redis) return;

  const payload = JSON.stringify({
    type: 'notification',
    notification: serializeNotification(notification),
  });

  try {
    await Promise.all(
      publishChannels(notification.userId, notification.bookGuid).map(channel =>
        redis.publish(channel, payload),
      ),
    );
  } catch (error) {
    console.warn('Failed to publish notification event:', error);
  }
}

export async function createNotification(input: CreateNotificationInput): Promise<AppNotification> {
  await ensureNotificationsTable();
  const rows = await prisma.$queryRaw<Array<{
    id: number;
    user_id: number;
    book_guid: string | null;
    type: string;
    severity: NotificationSeverity;
    title: string;
    message: string | null;
    href: string | null;
    source: string | null;
    source_id: string | null;
    read_at: Date | null;
    created_at: Date;
  }>>`
    INSERT INTO gnucash_web_notifications
      (user_id, book_guid, type, severity, title, message, href, source, source_id)
    VALUES
      (
        ${input.userId},
        ${input.bookGuid || null},
        ${input.type || 'background_job'},
        ${input.severity || 'info'},
        ${input.title},
        ${input.message || null},
        ${input.href || null},
        ${input.source || null},
        ${input.sourceId || null}
      )
    RETURNING
      id,
      user_id,
      book_guid,
      type,
      severity,
      title,
      message,
      href,
      source,
      source_id,
      read_at,
      created_at
  `;

  const row = rows[0];
  const notification = {
    id: row.id,
    userId: row.user_id,
    bookGuid: row.book_guid,
    type: row.type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    href: row.href,
    source: row.source,
    sourceId: row.source_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };

  await publishNotification(notification);
  return notification;
}

export async function listNotifications(userId: number, bookGuid: string, limit = 20) {
  await ensureNotificationsTable();

  const rows = await prisma.$queryRaw<Array<{
    id: number;
    user_id: number;
    book_guid: string | null;
    type: string;
    severity: NotificationSeverity;
    title: string;
    message: string | null;
    href: string | null;
    source: string | null;
    source_id: string | null;
    read_at: Date | null;
    created_at: Date;
  }>>`
    SELECT
      id,
      user_id,
      book_guid,
      type,
      severity,
      title,
      message,
      href,
      source,
      source_id,
      read_at,
      created_at
    FROM gnucash_web_notifications
    WHERE user_id = ${userId}
      AND (book_guid IS NULL OR book_guid = ${bookGuid})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  const unreadRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM gnucash_web_notifications
    WHERE user_id = ${userId}
      AND (book_guid IS NULL OR book_guid = ${bookGuid})
      AND read_at IS NULL
  `;

  return {
    unreadCount: Number(unreadRows[0]?.count || 0),
    notifications: rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      bookGuid: row.book_guid,
      type: row.type,
      severity: row.severity,
      title: row.title,
      message: row.message,
      href: row.href,
      source: row.source,
      sourceId: row.source_id,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
  };
}

export function getNotificationChannels(userId: number, bookGuid: string) {
  return notificationChannels(userId, bookGuid);
}

export async function markNotificationRead(userId: number, id: number): Promise<void> {
  await ensureNotificationsTable();
  await prisma.$executeRaw`
    UPDATE gnucash_web_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE id = ${id} AND user_id = ${userId}
  `;
}

export async function markAllNotificationsRead(userId: number, bookGuid: string): Promise<void> {
  await ensureNotificationsTable();
  await prisma.$executeRaw`
    UPDATE gnucash_web_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE user_id = ${userId}
      AND (book_guid IS NULL OR book_guid = ${bookGuid})
      AND read_at IS NULL
  `;
}

export async function syncSimpleFinStatusNotification(userId: number, bookGuid: string): Promise<void> {
  await ensureNotificationsTable();

  const rows = await prisma.$queryRaw<Array<{
    id: number;
    last_sync_status: string | null;
    last_sync_error: string | null;
    last_sync_error_at: Date | null;
  }>>`
    SELECT id, last_sync_status, last_sync_error, last_sync_error_at
    FROM gnucash_web_simplefin_connections
    WHERE user_id = ${userId}
      AND book_guid = ${bookGuid}
      AND last_sync_status IN ('failed', 'revoked')
      AND last_sync_error IS NOT NULL
      AND last_sync_error_at IS NOT NULL
  `;

  for (const row of rows) {
    const sourceId = `simplefin:${row.id}:${row.last_sync_status}:${row.last_sync_error_at?.getTime()}`;
    const exists = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM gnucash_web_notifications
      WHERE user_id = ${userId}
        AND source = 'simplefin'
        AND source_id = ${sourceId}
      LIMIT 1
    `;
    if (exists.length > 0) continue;

    await createNotification({
      userId,
      bookGuid,
      type: 'simplefin_sync',
      severity: row.last_sync_status === 'revoked' ? 'error' : 'warning',
      title: row.last_sync_status === 'revoked'
        ? 'SimpleFin connection revoked'
        : 'SimpleFin sync needs attention',
      message: row.last_sync_error,
      href: '/settings/connections',
      source: 'simplefin',
      sourceId,
    });
  }
}
