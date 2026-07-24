import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  complianceDeadlineEvents,
  fixedIncomeEvents,
  rmdEvents,
  scheduledTransactionEvents,
} from '@/lib/ical';
import { complianceItemsForYear } from '@/lib/compliance';
import { loadFixedIncomePositions, summarizeFixedIncome } from '@/lib/fixed-income';
import { fetchScheduledTransactions } from '@/lib/scheduled-transactions';
import { getPreference } from '@/lib/user-preferences';
import { listRenewals } from '@/lib/services/renewals.service';
import { listTasks } from '@/lib/services/home.service';
import { listInvoices } from '@/lib/business/invoice-engine';
import { listGoals } from '@/lib/services/goal.service';
import {
  currentOccurrence,
  listReportSchedules,
  schedulableReportLabel,
} from '@/lib/report-scheduler';
import { ENTITY_TYPES } from '@/lib/services/entity.service';
import { buildMoneyTimeline, eventStatus, isoDate } from './core';
import type { FinancialEvent, FinancialEventDomain, MoneyTimeline } from './types';

const DEFAULT_HORIZON_DAYS = 365;

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function normalizeDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : isoDate(value);
}

async function getBookCurrency(bookGuid: string): Promise<{ guid: string; mnemonic: string }> {
  const book = await prisma.books.findUnique({
    where: { guid: bookGuid },
    select: {
      root_account_guid: true,
    },
  });
  if (!book) return { guid: '', mnemonic: 'USD' };
  const root = await prisma.accounts.findUnique({
    where: { guid: book.root_account_guid },
    select: { commodity: { select: { guid: true, mnemonic: true } } },
  });
  return root?.commodity ?? { guid: '', mnemonic: 'USD' };
}

async function loadOpeningCash(bookAccountGuids: string[], asOf: Date): Promise<number> {
  if (bookAccountGuids.length === 0) return 0;
  const rows = await prisma.$queryRaw<Array<{ balance: unknown }>>`
    SELECT COALESCE(SUM(CAST(s.quantity_num AS numeric) / NULLIF(s.quantity_denom, 0)), 0) AS balance
    FROM splits s
    JOIN accounts a ON a.guid = s.account_guid
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE s.account_guid IN (${Prisma.join(bookAccountGuids)})
      AND a.account_type IN ('BANK', 'CASH')
      AND COALESCE(a.hidden, 0) = 0
      AND t.post_date <= ${asOf}
  `;
  const amount = Number(rows[0]?.balance ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function fromIcs(
  bookGuid: string,
  currency: string,
  domain: FinancialEventDomain,
  events: ReturnType<typeof scheduledTransactionEvents>,
  href: string,
  now: Date,
): FinancialEvent[] {
  return events.map(event => {
    const date = normalizeDate(event.date);
    const sourceId = event.uid.replace(/@gnucash-web$/, '');
    return {
      id: `${bookGuid}:${sourceId}`,
      bookGuid,
      domain,
      title: event.summary.replace(/^(Scheduled:|Due:)\s*/, ''),
      description: event.description ?? null,
      date,
      endDate: null,
      cashImpact: null,
      currency,
      confidence: domain === 'rmd' || domain === 'compliance' ? 1 : 0.9,
      status: eventStatus(date, domain === 'compliance' || domain === 'rmd', now),
      href,
      sourceId,
      actionId: null,
      planId: null,
      evidence: [{
        kind: domain === 'scheduled' ? 'rule' : 'assumption',
        id: sourceId,
        label: event.summary,
        source: 'system',
        observedAt: now.toISOString(),
      }],
      metadata: {},
    };
  });
}

async function loadPlanEvents(
  userId: number,
  bookGuid: string,
  currency: string,
  now: Date,
): Promise<FinancialEvent[]> {
  type Row = { id: string; life_events: unknown };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT p.id, v.life_events
    FROM gnucash_web_living_plans p
    JOIN gnucash_web_living_plan_versions v
      ON v.plan_id = p.id AND v.version = p.current_version
    WHERE p.user_id = ${userId}
      AND p.household_book_guid = ${bookGuid}
      AND p.status = 'adopted'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !Array.isArray(row.life_events)) return [];
  return row.life_events.flatMap((raw): FinancialEvent[] => {
    if (!raw || typeof raw !== 'object') return [];
    const event = raw as Record<string, unknown>;
    const date = typeof event.date === 'string' ? event.date.slice(0, 10) : '';
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    const id = typeof event.id === 'string' ? event.id : '';
    if (!date || !title || !id) return [];
    const amount = typeof event.cashImpact === 'number' && Number.isFinite(event.cashImpact)
      ? event.cashImpact
      : null;
    return [{
      id: `${bookGuid}:plan:${row.id}:${id}`,
      bookGuid,
      domain: event.type === 'equity_vest' ? 'equity_comp' : 'plan',
      title,
      description: typeof event.notes === 'string' ? event.notes : null,
      date,
      endDate: null,
      cashImpact: amount,
      currency,
      confidence: 0.75,
      status: eventStatus(date, true, now),
      href: event.type === 'equity_vest' ? '/investments/equity-comp' : '/planning/plan',
      sourceId: id,
      actionId: null,
      planId: row.id,
      evidence: [{
        kind: 'assumption',
        id,
        label: `Adopted plan event: ${title}`,
        source: 'manual',
        observedAt: now.toISOString(),
      }],
      metadata: { eventType: event.type ?? 'custom' },
    }];
  });
}

export async function collectFinancialEventsForBook(
  userId: number,
  bookGuid: string,
  now: Date = new Date(),
): Promise<{ events: FinancialEvent[]; openingCash: number; currency: string }> {
  const events: FinancialEvent[] = [];
  const accountGuids = await getAccountGuidsForBook(bookGuid);
  const accountSet = new Set(accountGuids);
  const liquidAccounts = new Set((await prisma.accounts.findMany({
    where: { guid: { in: accountGuids }, account_type: { in: ['BANK', 'CASH'] } },
    select: { guid: true },
  })).map(account => account.guid));
  const bookCurrency = await getBookCurrency(bookGuid);
  const currency = bookCurrency.mnemonic;

  const [openingCash, profile] = await Promise.all([
    loadOpeningCash(accountGuids, now),
    prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: bookGuid } }),
  ]);

  try {
    const scheduled = (await fetchScheduledTransactions(true))
      .filter(tx => tx.splits.some(split => accountSet.has(split.accountGuid)));
    const sourceByGuid = new Map(scheduled.map(tx => [tx.guid, tx]));
    const mapped = fromIcs(
      bookGuid,
      currency,
      'scheduled',
      scheduledTransactionEvents(scheduled, now, DEFAULT_HORIZON_DAYS),
      '/scheduled-transactions',
      now,
    );
    for (const event of mapped) {
      const guid = event.sourceId.split('-').slice(1, -1).join('-');
      const tx = sourceByGuid.get(guid);
      if (tx) {
        const cashSplits = tx.splits.filter(split => liquidAccounts.has(split.accountGuid));
        const signed = cashSplits.reduce((sum, split) => sum + split.amount, 0);
        event.cashImpact = cashSplits.length > 0 && Number.isFinite(signed)
          ? Math.round(signed * 100) / 100
          : null;
      }
    }
    events.push(...mapped);
  } catch (error) {
    console.warn('Money Timeline scheduled source failed:', error);
  }

  try {
    const positions = await loadFixedIncomePositions(accountGuids, now);
    const summary = summarizeFixedIncome(positions, now);
    const mapped = fromIcs(
      bookGuid,
      currency,
      'fixed_income',
      fixedIncomeEvents(summary.upcomingMaturities, summary.couponPayments),
      '/investments/fixed-income',
      now,
    );
    for (const event of mapped) {
      const amountMatch = event.description?.match(/(?:Face value|coupon of)\s+([\d,.]+)/i);
      if (amountMatch) event.cashImpact = Number(amountMatch[1].replace(/,/g, '')) || null;
    }
    events.push(...mapped);
  } catch (error) {
    console.warn('Money Timeline fixed-income source failed:', error);
  }

  try {
    const birthday = await getPreference<string | null>(userId, 'birthday', null);
    events.push(...fromIcs(bookGuid, currency, 'rmd', rmdEvents(birthday, now), '/tools/drawdown', now));
  } catch (error) {
    console.warn('Money Timeline RMD source failed:', error);
  }

  try {
    const entityType = profile && (ENTITY_TYPES as readonly string[]).includes(profile.entity_type)
      ? profile.entity_type as (typeof ENTITY_TYPES)[number]
      : 'household';
    const activity = profile?.business_activity === 'farm' ? 'farm' : 'general';
    const items = [
      ...complianceItemsForYear(entityType, profile?.tax_state ?? null, now.getFullYear(), activity),
      ...complianceItemsForYear(entityType, profile?.tax_state ?? null, now.getFullYear() + 1, activity),
    ];
    const statusRows = await prisma.gnucash_web_compliance_status.findMany({
      where: { book_guid: bookGuid },
      select: { item_key: true, period: true },
    });
    const resolved = new Set(statusRows.map(row => `${row.item_key}|${row.period}`));
    events.push(...fromIcs(
      bookGuid,
      currency,
      'compliance',
      complianceDeadlineEvents(items, resolved, now),
      '/taxes/compliance',
      now,
    ));
  } catch (error) {
    console.warn('Money Timeline compliance source failed:', error);
  }

  try {
    for (const renewal of await listRenewals(bookGuid)) {
      events.push({
        id: `${bookGuid}:renewal:${renewal.id}:${renewal.renewalDate}`,
        bookGuid,
        domain: 'renewal',
        title: renewal.name,
        description: renewal.notes,
        date: renewal.renewalDate,
        endDate: null,
        cashImpact: renewal.amount === null ? null : -Math.abs(renewal.amount),
        currency,
        confidence: renewal.amount === null ? 0.8 : 0.95,
        status: eventStatus(renewal.renewalDate, true, now),
        href: '/tools/renewals',
        sourceId: String(renewal.id),
        actionId: null,
        planId: null,
        evidence: [{ kind: 'rule', id: String(renewal.id), label: renewal.name, source: 'manual' }],
        metadata: { cadenceMonths: renewal.cadenceMonths },
      });
    }
  } catch (error) {
    console.warn('Money Timeline renewal source failed:', error);
  }

  try {
    const [{ listItems }, tasks] = await Promise.all([
      import('@/lib/services/home.service'),
      listTasks(bookGuid),
    ]);
    for (const task of tasks) {
      if (!task.nextDue) continue;
      events.push({
        id: `${bookGuid}:home:${task.id}:${task.nextDue}`,
        bookGuid,
        domain: 'home',
        title: task.name,
        description: task.notes,
        date: task.nextDue,
        endDate: null,
        cashImpact: null,
        currency,
        confidence: 0.85,
        status: eventStatus(task.nextDue, true, now),
        href: '/home/maintenance',
        sourceId: String(task.id),
        actionId: null,
        planId: null,
        evidence: [{ kind: 'rule', id: String(task.id), label: task.name, source: 'manual' }],
        metadata: { cadenceMonths: task.cadenceMonths, itemName: task.itemName },
      });
    }
    for (const item of await listItems(bookGuid)) {
      if (!item.warrantyExpires) continue;
      events.push({
        id: `${bookGuid}:home-warranty:${item.id}:${item.warrantyExpires}`,
        bookGuid,
        domain: 'home',
        title: `Warranty expires: ${item.name || 'Inventory item'}`,
        description: item.notes,
        date: item.warrantyExpires,
        endDate: null,
        cashImpact: null,
        currency,
        confidence: 1,
        status: eventStatus(item.warrantyExpires, true, now),
        href: '/home/inventory',
        sourceId: `warranty:${item.id}`,
        actionId: null,
        planId: null,
        evidence: [{ kind: 'assumption', id: String(item.id), label: 'Recorded warranty date', source: 'manual' }],
        metadata: { itemId: item.id, eventType: 'warranty' },
      });
    }
  } catch (error) {
    console.warn('Money Timeline home source failed:', error);
  }

  try {
    const invoices = await listInvoices({ limit: 1_000 });
    for (const invoice of invoices) {
      if (!invoice.dueDate || !invoice.postAccountGuid || !accountSet.has(invoice.postAccountGuid)) continue;
      if (invoice.status === 'paid' || invoice.amountDue <= 0) continue;
      const cashImpact = invoice.type === 'invoice'
        ? Math.abs(invoice.amountDue)
        : -Math.abs(invoice.amountDue);
      events.push({
        id: `${bookGuid}:invoice:${invoice.guid}:${invoice.dueDate}`,
        bookGuid,
        domain: 'invoice',
        title: `${invoice.type === 'invoice' ? 'Invoice' : 'Bill'} ${invoice.id} · ${invoice.ownerName}`,
        description: invoice.notes || null,
        date: invoice.dueDate,
        endDate: null,
        cashImpact,
        currency,
        confidence: 1,
        status: eventStatus(invoice.dueDate, true, now),
        href: invoice.type === 'invoice' ? '/business/invoices' : '/business/vouchers',
        sourceId: invoice.guid,
        actionId: null,
        planId: null,
        evidence: [{ kind: 'transaction', id: invoice.postTxnGuid ?? invoice.guid, label: invoice.id, source: 'system' }],
        metadata: { invoiceStatus: invoice.status },
      });
    }
  } catch (error) {
    console.warn('Money Timeline invoice source failed:', error);
  }

  try {
    for (const goal of await listGoals(bookGuid)) {
      if (!goal.targetDate) continue;
      events.push({
        id: `${bookGuid}:goal:${goal.id}:${goal.targetDate}`,
        bookGuid,
        domain: 'goal',
        title: goal.name,
        description: `Goal deadline${goal.targetAmount === null ? '' : ` · target ${goal.targetAmount.toFixed(2)}`}`,
        date: goal.targetDate,
        endDate: null,
        cashImpact: null,
        currency,
        confidence: 0.7,
        status: eventStatus(goal.targetDate, true, now),
        href: '/goals',
        sourceId: String(goal.id),
        actionId: null,
        planId: null,
        evidence: [{ kind: 'assumption', id: String(goal.id), label: goal.name, source: 'manual' }],
        metadata: { goalType: goal.goalType },
      });
    }
  } catch (error) {
    console.warn('Money Timeline goal source failed:', error);
  }

  try {
    const schedules = await listReportSchedules(userId, bookGuid);
    for (const schedule of schedules.filter(item => item.enabled)) {
      const current = currentOccurrence(schedule.cadence, schedule.anchorDay, now);
      let cursor = new Date(now);
      let next = current;
      if (schedule.lastRunPeriod === current) {
        for (let days = 1; days <= 370 && next === current; days++) {
          cursor = addDays(now, days);
          next = currentOccurrence(schedule.cadence, schedule.anchorDay, cursor);
        }
      }
      events.push({
        id: `${bookGuid}:report-schedule:${schedule.id}:${next}`,
        bookGuid,
        domain: 'report_schedule',
        title: `Deliver ${schedulableReportLabel(schedule.baseReportType ?? 'saved report')}`,
        description: schedule.recipients ? `Recipients: ${schedule.recipients}` : 'Delivered to the account owner.',
        date: next,
        endDate: null,
        cashImpact: null,
        currency,
        confidence: 1,
        status: eventStatus(next, schedule.lastRunPeriod !== current, now),
        href: '/settings',
        sourceId: String(schedule.id),
        actionId: null,
        planId: null,
        evidence: [{ kind: 'rule', id: String(schedule.id), label: `${schedule.cadence} report schedule`, source: 'system' }],
        metadata: { cadence: schedule.cadence },
      });
    }
  } catch (error) {
    console.warn('Money Timeline report-schedule source failed:', error);
  }

  events.push(...await loadPlanEvents(userId, bookGuid, currency, now));
  return { events, openingCash, currency };
}

export async function getMoneyTimeline(
  userId: number,
  bookGuid: string,
  options: { from?: string; to?: string; minimumCash?: number; now?: Date } = {},
): Promise<MoneyTimeline> {
  const now = options.now ?? new Date();
  const from = options.from ?? isoDate(addDays(now, -30));
  const to = options.to ?? isoDate(addDays(now, DEFAULT_HORIZON_DAYS));
  const loaded = await collectFinancialEventsForBook(userId, bookGuid, now);
  return buildMoneyTimeline(
    loaded.events,
    from,
    to,
    loaded.currency,
    loaded.openingCash,
    options.minimumCash ?? 0,
    now,
  );
}
