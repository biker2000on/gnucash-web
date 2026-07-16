/**
 * Dunning (automated payment reminders) — settings + pure scheduling logic.
 *
 * Per book: an enabled flag, a days-overdue schedule (e.g. [7, 14, 30]), and
 * subject/body email templates with {{customer}}, {{invoice_no}},
 * {{amount_due}}, {{days_overdue}} placeholders.
 *
 * The daily worker job (src/lib/queue/jobs/dunning.ts) walks posted, unpaid
 * customer invoices past their due date and sends AT MOST ONE email per
 * invoice per schedule threshold:
 *
 *   level to send = the highest schedule day <= daysOverdue that is greater
 *                   than every level already logged for the invoice
 *
 * so a worker outage never causes a burst of stacked reminders (only the
 * highest crossed threshold fires), and re-runs on the same day are no-ops
 * (the level is already in gnucash_web_dunning_log). Per-invoice opt-outs
 * (gnucash_web_dunning_optout) suppress sending entirely.
 */

import prisma from '@/lib/prisma';

export const DEFAULT_DUNNING_SCHEDULE = [7, 14, 30];

export const DEFAULT_DUNNING_SUBJECT = 'Payment reminder — invoice {{invoice_no}}';

export const DEFAULT_DUNNING_BODY = `Hello {{customer}},

This is a friendly reminder that invoice {{invoice_no}} is {{days_overdue}} days past due. The outstanding balance is {{amount_due}}.

You can view the invoice online here: {{link}}

If you have already sent payment, please disregard this notice. Thank you!`;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw schedule (JSON from DB or request body) into a sorted,
 * deduplicated list of positive integer day offsets. Invalid or empty input
 * falls back to the default schedule.
 */
export function parseDunningSchedule(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const days = arr
    .map((v) => (typeof v === 'string' ? parseInt(v, 10) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 3650);
  const unique = Array.from(new Set(days)).sort((a, b) => a - b);
  return unique.length > 0 ? unique.slice(0, 10) : [...DEFAULT_DUNNING_SCHEDULE];
}

/** Whole days an invoice is overdue (0 when due today or not yet due). */
export function daysOverdue(dueDate: Date, now: Date = new Date()): number {
  const ms = now.getTime() - dueDate.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * The next dunning level (schedule day value) to send for an invoice, or
 * null when nothing new is due.
 *
 * Rules:
 *   - only thresholds actually crossed (day <= daysOverdue) are candidates
 *   - only the HIGHEST crossed threshold fires (no stacked catch-up emails)
 *   - a level never fires twice: any logged level >= the candidate blocks it
 */
export function nextDunningLevel(
  schedule: number[],
  overdueDays: number,
  sentLevels: number[],
): number | null {
  const crossed = schedule.filter((day) => day > 0 && day <= overdueDays);
  if (crossed.length === 0) return null;
  const candidate = Math.max(...crossed);
  const maxSent = sentLevels.length > 0 ? Math.max(...sentLevels) : -Infinity;
  return candidate > maxSent ? candidate : null;
}

export interface DunningTemplateVars {
  customer: string;
  invoice_no: string;
  amount_due: string;
  days_overdue: string;
  link: string;
}

/** Substitute {{placeholder}} tokens; unknown placeholders are left intact. */
export function renderDunningTemplate(template: string, vars: DunningTemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = (vars as unknown as Record<string, string>)[key];
    return value !== undefined ? value : match;
  });
}

// ---------------------------------------------------------------------------
// Settings (per book)
// ---------------------------------------------------------------------------

export interface DunningSettings {
  enabled: boolean;
  schedule: number[];
  emailSubject: string;
  emailBody: string;
}

export const DEFAULT_DUNNING_SETTINGS: DunningSettings = {
  enabled: false,
  schedule: [...DEFAULT_DUNNING_SCHEDULE],
  emailSubject: DEFAULT_DUNNING_SUBJECT,
  emailBody: DEFAULT_DUNNING_BODY,
};

export async function getDunningSettings(bookGuid: string): Promise<DunningSettings> {
  const row = await prisma.gnucash_web_dunning_settings.findUnique({
    where: { book_guid: bookGuid },
  });
  if (!row) return { ...DEFAULT_DUNNING_SETTINGS, schedule: [...DEFAULT_DUNNING_SCHEDULE] };
  return {
    enabled: row.enabled,
    schedule: parseDunningSchedule(row.schedule),
    emailSubject: row.email_subject?.trim() || DEFAULT_DUNNING_SUBJECT,
    emailBody: row.email_body?.trim() || DEFAULT_DUNNING_BODY,
  };
}

export interface SaveDunningSettingsInput {
  enabled?: boolean;
  schedule?: unknown;
  emailSubject?: string | null;
  emailBody?: string | null;
}

export async function saveDunningSettings(
  bookGuid: string,
  input: SaveDunningSettingsInput,
): Promise<DunningSettings> {
  const current = await getDunningSettings(bookGuid);
  const next: DunningSettings = {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
    schedule: input.schedule !== undefined ? parseDunningSchedule(input.schedule) : current.schedule,
    emailSubject:
      input.emailSubject !== undefined
        ? (input.emailSubject?.trim() || DEFAULT_DUNNING_SUBJECT).slice(0, 255)
        : current.emailSubject,
    emailBody:
      input.emailBody !== undefined
        ? input.emailBody?.trim() || DEFAULT_DUNNING_BODY
        : current.emailBody,
  };

  await prisma.gnucash_web_dunning_settings.upsert({
    where: { book_guid: bookGuid },
    create: {
      book_guid: bookGuid,
      enabled: next.enabled,
      schedule: next.schedule,
      email_subject: next.emailSubject,
      email_body: next.emailBody,
    },
    update: {
      enabled: next.enabled,
      schedule: next.schedule,
      email_subject: next.emailSubject,
      email_body: next.emailBody,
      updated_at: new Date(),
    },
  });

  return next;
}

// ---------------------------------------------------------------------------
// Per-invoice opt-out
// ---------------------------------------------------------------------------

export async function isDunningOptedOut(invoiceGuid: string): Promise<boolean> {
  const row = await prisma.gnucash_web_dunning_optout.findUnique({
    where: { invoice_guid: invoiceGuid },
    select: { invoice_guid: true },
  });
  return Boolean(row);
}

export async function setDunningOptOut(
  bookGuid: string,
  invoiceGuid: string,
  optedOut: boolean,
): Promise<void> {
  if (optedOut) {
    await prisma.gnucash_web_dunning_optout.upsert({
      where: { invoice_guid: invoiceGuid },
      create: { invoice_guid: invoiceGuid, book_guid: bookGuid },
      update: { book_guid: bookGuid },
    });
  } else {
    await prisma.gnucash_web_dunning_optout.deleteMany({
      where: { invoice_guid: invoiceGuid, book_guid: bookGuid },
    });
  }
}
