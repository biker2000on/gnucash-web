import type { Job } from 'bullmq';
import prisma from '@/lib/prisma';
import { getPreference } from '@/lib/user-preferences';
import type { NotificationSeverity } from '@/lib/notifications';
import {
  isEmailConfigured,
  parseEmailPrefs,
  shouldEmailNotification,
  renderNotificationEmail,
  sendEmail,
} from '@/lib/email';

export interface SendEmailJobData {
  userId: number;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string | null;
  href: string | null;
}

/**
 * Deliver one notification by email, honoring the user's email preferences.
 * Preference checks happen here (not at enqueue time) so the queue path in
 * createNotification stays fast and prefs are always read fresh.
 */
export async function handleSendEmail(job: Job): Promise<void> {
  const data = job.data as SendEmailJobData;
  if (!isEmailConfigured()) return;

  const rawPrefs = await getPreference<unknown>(data.userId, 'email_notifications', null);
  const prefs = parseEmailPrefs(rawPrefs);
  if (!shouldEmailNotification(prefs, data.type, data.severity)) return;

  const user = await prisma.gnucash_web_users.findUnique({
    where: { id: data.userId },
    select: { email: true },
  });
  if (!user?.email) return;

  const { subject, text, html } = renderNotificationEmail({
    title: data.title,
    message: data.message,
    href: data.href,
    severity: data.severity,
    type: data.type,
  });

  const sent = await sendEmail({ to: user.email, subject, text, html });
  if (sent) {
    console.log(`Emailed notification "${data.title}" to user ${data.userId}`);
  }
}
