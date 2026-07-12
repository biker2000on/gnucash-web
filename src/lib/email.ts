import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationSeverity } from '@/lib/notifications';

/**
 * SMTP email delivery.
 *
 * Configured entirely by environment variables:
 *   SMTP_HOST      required — SMTP server hostname; email is disabled when unset
 *   SMTP_PORT      default 587
 *   SMTP_SECURE    'true' for implicit TLS (port 465); default false (STARTTLS)
 *   SMTP_USER      optional auth user
 *   SMTP_PASS      optional auth password
 *   SMTP_FROM      default 'GnuCash Web <gnucash-web@localhost>'
 *   APP_BASE_URL   used to absolutize notification links in email bodies
 */

let transporter: Transporter | null = null;

export function isEmailConfigured(): boolean {
    return Boolean(process.env.SMTP_HOST);
}

function getTransporter(): Transporter | null {
    if (!isEmailConfigured()) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
                : undefined,
        });
    }
    return transporter;
}

export interface SendEmailInput {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

/** Send one email. Returns false (without throwing) when SMTP is unconfigured. */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
    const transport = getTransporter();
    if (!transport) return false;
    await transport.sendMail({
        from: process.env.SMTP_FROM || 'GnuCash Web <gnucash-web@localhost>',
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
    });
    return true;
}

// ---------------------------------------------------------------------------
// Notification email preferences + rendering
// ---------------------------------------------------------------------------

export interface EmailNotificationPrefs {
    enabled: boolean;
    /** Minimum severity to email: 'info' emails everything. */
    minSeverity: 'info' | 'warning' | 'error';
    /** Notification types to email, or 'all'. */
    types: 'all' | string[];
}

export const DEFAULT_EMAIL_PREFS: EmailNotificationPrefs = {
    enabled: false,
    minSeverity: 'info',
    types: 'all',
};

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
    info: 0,
    success: 0,
    warning: 1,
    error: 2,
};

export function parseEmailPrefs(raw: unknown): EmailNotificationPrefs {
    if (!raw || typeof raw !== 'object') return DEFAULT_EMAIL_PREFS;
    const obj = raw as Record<string, unknown>;
    const minSeverity = obj.minSeverity === 'warning' || obj.minSeverity === 'error' ? obj.minSeverity : 'info';
    const types = Array.isArray(obj.types)
        ? (obj.types.filter(t => typeof t === 'string') as string[])
        : 'all';
    return {
        enabled: obj.enabled === true,
        minSeverity,
        types,
    };
}

/** Decide whether a notification should be emailed under the given prefs. */
export function shouldEmailNotification(
    prefs: EmailNotificationPrefs,
    type: string,
    severity: NotificationSeverity,
): boolean {
    if (!prefs.enabled) return false;
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[prefs.minSeverity]) return false;
    if (prefs.types !== 'all' && !prefs.types.includes(type)) return false;
    return true;
}

export interface NotificationEmailInput {
    title: string;
    message: string | null;
    href: string | null;
    severity: NotificationSeverity;
    type: string;
}

const SEVERITY_COLOR: Record<NotificationSeverity, string> = {
    info: '#38bdf8',
    success: '#34d399',
    warning: '#fbbf24',
    error: '#fb7185',
};

export function renderNotificationEmail(input: NotificationEmailInput): { subject: string; text: string; html: string } {
    const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const link = input.href
        ? (input.href.startsWith('http') ? input.href : `${base}${input.href}`)
        : null;

    const subject = `[GnuCash Web] ${input.title}`;
    const textLines = [input.title];
    if (input.message) textLines.push('', input.message);
    if (link) textLines.push('', `Open: ${link}`);
    const text = textLines.join('\n');

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0b1220;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#111a2e;border:1px solid #24304a;border-radius:12px;overflow:hidden;">
    <div style="padding:4px 0;background:${SEVERITY_COLOR[input.severity]};"></div>
    <div style="padding:24px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#7d8bab;margin-bottom:8px;">
        GnuCash Web · ${input.type.replace(/_/g, ' ')}
      </div>
      <h1 style="margin:0 0 12px;font-size:18px;color:#e8edf7;">${escapeHtml(input.title)}</h1>
      ${input.message ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#aeb9d0;white-space:pre-line;">${escapeHtml(input.message)}</p>` : ''}
      ${link ? `<a href="${link}" style="display:inline-block;padding:10px 18px;background:#2dd4bf;color:#04211c;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">View in GnuCash Web</a>` : ''}
    </div>
    <div style="padding:12px 24px;border-top:1px solid #24304a;font-size:11px;color:#7d8bab;">
      You are receiving this because email notifications are enabled in Settings.
    </div>
  </div>
</body></html>`;

    return { subject, text, html };
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
