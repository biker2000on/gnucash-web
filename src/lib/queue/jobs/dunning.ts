import type { Job } from 'bullmq';

/**
 * Daily dunning run (automated payment reminders).
 *
 * For every book with dunning enabled (gnucash_web_dunning_settings.enabled):
 *   - load posted, unpaid CUSTOMER invoices (book-scoped via post_acc)
 *   - compute days overdue from date_posted + billterm duedays
 *   - pick the next dunning level per invoice (highest crossed schedule
 *     threshold not yet logged — see nextDunningLevel in dunning.ts)
 *   - skip invoices in gnucash_web_dunning_optout or without a customer email
 *   - email the customer (templates + placeholders from settings), including
 *     a public share link (reused or auto-created, non-expiring)
 *   - log every send in gnucash_web_dunning_log (dedupe source of truth)
 *
 * SMTP unconfigured => the run is a no-op (logged, nothing sent or logged).
 *
 * Worker wiring (owned by worker.ts):
 *   case 'dunning': { ... }
 * Suggested schedule: daily (setScheduleGeneric('dunning', '07:30', ...)).
 */

export interface DunningRunResult {
  booksScanned: number;
  invoicesConsidered: number;
  emailsSent: number;
  skippedOptOut: number;
  skippedNoEmail: number;
  errors: number;
}

export async function handleDunning(job: Job): Promise<DunningRunResult> {
  const prisma = (await import('@/lib/prisma')).default;
  const { isEmailConfigured, sendEmail } = await import('@/lib/email');
  const {
    getDunningSettings,
    nextDunningLevel,
    renderDunningTemplate,
    daysOverdue,
  } = await import('@/lib/business/dunning');
  const { loadOpenInvoices, computeDueDate, amountDueFromLotBalance } = await import(
    '@/lib/business/business-reports'
  );
  const { findOrCreateInvoiceShare } = await import('@/lib/business/invoice-shares.service');
  const { getAccountGuidsForBook } = await import('@/lib/book-scope');

  const result: DunningRunResult = {
    booksScanned: 0,
    invoicesConsidered: 0,
    emailsSent: 0,
    skippedOptOut: 0,
    skippedNoEmail: 0,
    errors: 0,
  };

  if (!isEmailConfigured()) {
    console.log(`[Job ${job.id}] Dunning: SMTP not configured — skipping run`);
    return result;
  }

  const { bookGuid } = (job.data ?? {}) as { bookGuid?: string };
  const enabledSettings = await prisma.gnucash_web_dunning_settings.findMany({
    where: { enabled: true, ...(bookGuid ? { book_guid: bookGuid } : {}) },
    select: { book_guid: true },
  });
  if (enabledSettings.length === 0) {
    console.log(`[Job ${job.id}] Dunning: no books with dunning enabled`);
    return result;
  }

  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const now = new Date();

  for (const { book_guid: book } of enabledSettings) {
    result.booksScanned++;
    try {
      const settings = await getDunningSettings(book);
      const accountGuids = await getAccountGuidsForBook(book);
      if (accountGuids.length === 0) continue;

      const openInvoices = await loadOpenInvoices('ar', accountGuids);
      if (openInvoices.length === 0) continue;

      // Batch: opt-outs, prior log rows, and customer emails for this book.
      const invoiceGuids = openInvoices.map((i) => i.guid);
      const [optouts, logRows, customers] = await Promise.all([
        prisma.gnucash_web_dunning_optout.findMany({
          where: { invoice_guid: { in: invoiceGuids } },
          select: { invoice_guid: true },
        }),
        prisma.gnucash_web_dunning_log.findMany({
          where: { book_guid: book, invoice_guid: { in: invoiceGuids } },
          select: { invoice_guid: true, level: true },
        }),
        prisma.customers.findMany({
          where: { guid: { in: Array.from(new Set(openInvoices.map((i) => i.ownerGuid))) } },
          select: { guid: true, name: true, addr_email: true },
        }),
      ]);
      const optedOut = new Set(optouts.map((o) => o.invoice_guid));
      const sentLevelsByInvoice = new Map<string, number[]>();
      for (const row of logRows) {
        const arr = sentLevelsByInvoice.get(row.invoice_guid) ?? [];
        arr.push(row.level);
        sentLevelsByInvoice.set(row.invoice_guid, arr);
      }
      const customerByGuid = new Map(customers.map((c) => [c.guid, c]));

      for (const inv of openInvoices) {
        result.invoicesConsidered++;
        try {
          const posted = inv.datePosted ? new Date(inv.datePosted) : null;
          if (!posted) continue;
          const dueDate = computeDueDate(posted, inv.dueDays);
          const overdue = daysOverdue(dueDate, now);
          if (overdue <= 0) continue;

          const level = nextDunningLevel(
            settings.schedule,
            overdue,
            sentLevelsByInvoice.get(inv.guid) ?? [],
          );
          if (level === null) continue;

          if (optedOut.has(inv.guid)) {
            result.skippedOptOut++;
            continue;
          }

          const customer = customerByGuid.get(inv.ownerGuid);
          const email = customer?.addr_email?.trim();
          if (!email) {
            result.skippedNoEmail++;
            continue;
          }

          const amountDue = amountDueFromLotBalance(inv.lotBalance, 'ar');
          const share = await findOrCreateInvoiceShare(book, inv.guid);
          const link = `${baseUrl}${share.path}`;

          const vars = {
            customer: customer?.name ?? inv.ownerName,
            invoice_no: inv.id,
            amount_due: `${amountDue.toFixed(2)} ${inv.currency}`,
            days_overdue: String(overdue),
            link,
          };
          const subject = renderDunningTemplate(settings.emailSubject, vars);
          let body = renderDunningTemplate(settings.emailBody, vars);
          if (!settings.emailBody.includes('{{link}}')) {
            body += `\n\nView your invoice: ${link}`;
          }

          const sent = await sendEmail({ to: email, subject, text: body });
          if (!sent) continue;

          await prisma.gnucash_web_dunning_log.create({
            data: { book_guid: book, invoice_guid: inv.guid, level, recipient: email },
          });
          result.emailsSent++;
        } catch (err) {
          result.errors++;
          console.error(`[Job ${job.id}] Dunning failed for invoice ${inv.guid}:`, err);
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[Job ${job.id}] Dunning failed for book ${book}:`, err);
    }
  }

  console.log(
    `[Job ${job.id}] Dunning: ${result.booksScanned} book(s), ` +
      `${result.invoicesConsidered} invoice(s) considered, ${result.emailsSent} email(s) sent, ` +
      `${result.skippedOptOut} opted out, ${result.skippedNoEmail} without email, ${result.errors} error(s)`,
  );
  return result;
}
