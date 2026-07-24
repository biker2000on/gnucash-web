import prisma from '@/lib/prisma';
import { runDataHealth } from '@/lib/data-health';
import { listInsights } from '@/lib/insights';
import { listNotifications } from '@/lib/notifications';
import { complianceItemsForYear, complianceStatusKey } from '@/lib/compliance';
import { getEntityProfile } from '@/lib/services/entity.service';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import { listBatches, ensureStatementTables } from '@/lib/services/statement.service';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { generateInvestmentPortfolio } from '@/lib/reports/investment-portfolio';
import { detectRecurringCharges } from '@/lib/recurring-detection';
import { computeRebalance } from '@/lib/rebalancing';
import { parseRebalanceConfig } from '@/lib/rebalancing-sector';
import { createCalculationTrace } from '@/lib/provenance';
import { getBaseCurrency } from '@/lib/currency';
import { getFarmCertificateObligations } from '@/lib/tax/farm-certificates';
import { detectOpportunities, type OpportunitySignal, type OpportunitySnapshot } from './opportunity-engine';
import type {
  EvidenceRef,
  FinancialActionCandidate,
  FinancialActionSeverity,
} from './types';

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysUntil(date: string, now = new Date()): number {
  return Math.ceil((new Date(`${date}T23:59:59Z`).getTime() - now.getTime()) / DAY_MS);
}

function severityFromDueDate(date: string): FinancialActionSeverity {
  const remaining = daysUntil(date);
  if (remaining < 0) return 'critical';
  if (remaining <= 14) return 'warning';
  return 'info';
}

function sourceAction(input: Omit<FinancialActionCandidate, 'trace'> & {
  traceTitle?: string;
  evidence?: EvidenceRef[];
  assumptions?: string[];
  asOfDate?: string;
  traceResult?: number | string | boolean | null;
}): FinancialActionCandidate {
  const {
    traceTitle,
    evidence,
    assumptions,
    asOfDate,
    traceResult,
    ...candidate
  } = input;
  const trace = createCalculationTrace({
    namespace: `financial-action:${input.origin}`,
    identity: { stableKey: input.stableKey },
    title: traceTitle ?? `Why “${input.title}” needs attention`,
    summary: input.summary,
    asOfDate,
    result: traceResult ?? input.impact?.high ?? 1,
    unit: input.impact ? 'currency' : 'count',
    evidence,
    assumptions,
    metadata: input.metadata,
  });
  return { ...candidate, trace };
}

async function transactionReviewActions(
  bookAccountGuids: string[],
): Promise<FinancialActionCandidate[]> {
  const rows = await prisma.$queryRaw<Array<{
    guid: string;
    description: string | null;
    post_date: Date;
    confidence: string | null;
    source: string;
  }>>`
    SELECT DISTINCT t.guid, t.description, t.post_date, m.confidence, m.source
    FROM gnucash_web_transaction_meta m
    JOIN transactions t ON t.guid = m.transaction_guid
    JOIN splits s ON s.tx_guid = t.guid
    WHERE m.reviewed = FALSE
      AND m.deleted_at IS NULL
      AND s.account_guid = ANY(${bookAccountGuids}::text[])
    ORDER BY t.post_date DESC
    LIMIT 100
  `;
  return rows.map(row => sourceAction({
    stableKey: `transaction-review:${row.guid}`,
    lane: 'fix',
    origin: 'transaction_review',
    sourceId: row.guid,
    severity: row.confidence === 'low' ? 'warning' : 'info',
    title: row.description || 'Review imported transaction',
    summary: `Imported ${isoDate(row.post_date)} and still needs a human review.`,
    dueDate: null,
    impact: null,
    confidence: row.confidence === 'low' ? 0.6 : 0.8,
    operations: [
      { id: 'review', label: 'Review transaction', kind: 'link', href: `/ledger?transaction=${row.guid}`, primary: true },
      { id: 'rule', label: 'Create a rule', kind: 'create_rule', href: `/settings/rules?transaction=${row.guid}` },
      { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
    ],
    evidence: [{
      kind: 'transaction',
      id: row.guid,
      label: row.description || 'Imported transaction',
      source: row.source === 'simplefin' ? 'simplefin' : 'manual',
      href: `/ledger?transaction=${row.guid}`,
      observedAt: isoDate(row.post_date),
      verified: false,
    }],
  }));
}

async function receiptActions(bookGuid: string): Promise<FinancialActionCandidate[]> {
  const rows = await prisma.$queryRaw<Array<{
    id: number;
    filename: string;
    ocr_status: string;
    transaction_guid: string | null;
    created_at: Date;
  }>>`
    SELECT id, filename, ocr_status, transaction_guid, created_at
    FROM gnucash_web_receipts
    WHERE book_guid = ${bookGuid}
      AND (
        transaction_guid IS NULL
        OR ocr_status = 'failed'
        OR (ocr_status = 'pending' AND created_at < NOW() - INTERVAL '1 hour')
      )
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.map(row => {
    const failed = row.ocr_status === 'failed';
    return sourceAction({
      stableKey: `receipt:${row.id}:${failed ? 'ocr' : 'unmatched'}`,
      lane: 'fix',
      origin: 'receipt_inbox',
      sourceId: String(row.id),
      severity: failed ? 'warning' : 'info',
      title: failed ? `Receipt OCR failed: ${row.filename}` : `Match receipt: ${row.filename}`,
      summary: failed
        ? 'The receipt could not be read automatically and needs a manual check.'
        : 'This receipt is not attached to a ledger transaction.',
      dueDate: null,
      impact: null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Open receipt inbox', kind: 'link', href: `/receipts?receipt=${row.id}`, primary: true },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      evidence: [{
        kind: 'receipt',
        id: String(row.id),
        label: row.filename,
        source: 'receipt',
        href: `/receipts?receipt=${row.id}`,
        observedAt: row.created_at.toISOString(),
        verified: false,
      }],
    });
  });
}

async function statementActions(bookGuid: string): Promise<FinancialActionCandidate[]> {
  await ensureStatementTables();
  const batches = (await listBatches(bookGuid)).slice(0, 100);
  const rows = await prisma.$queryRaw<Array<{ batch_id: number; unmatched: number }>>`
    SELECT l.batch_id, COUNT(*)::int AS unmatched
    FROM gnucash_web_statement_lines l
    JOIN gnucash_web_statement_batches b ON b.id = l.batch_id
    WHERE b.book_guid = ${bookGuid}
      AND l.match_state = 'unmatched'
    GROUP BY l.batch_id
  `;
  const unmatchedByBatch = new Map(rows.map(row => [row.batch_id, row.unmatched]));
  return batches.flatMap(batch => {
    const unmatched = unmatchedByBatch.get(batch.id) ?? 0;
    if (batch.status === 'reconciled' && unmatched === 0) return [];
    const failed = batch.status === 'error';
    return [sourceAction({
      stableKey: `statement:${batch.id}`,
      lane: 'fix',
      origin: 'statement_reconciliation',
      sourceId: String(batch.id),
      severity: failed ? 'critical' : unmatched > 0 ? 'warning' : 'info',
      title: failed ? `Statement import failed: ${batch.originalFilename}` : `Finish statement: ${batch.originalFilename}`,
      summary: failed
        ? batch.error || 'The statement could not be processed.'
        : `${unmatched} unmatched line${unmatched === 1 ? '' : 's'} remain before reconciliation is complete.`,
      dueDate: null,
      impact: null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Reconcile statement', kind: 'link', href: `/statements/${batch.id}`, primary: true },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      traceResult: unmatched,
      evidence: [{
        kind: 'statement',
        id: String(batch.id),
        label: batch.originalFilename,
        source: 'statement',
        href: `/statements/${batch.id}`,
        observedAt: batch.updatedAt.toISOString(),
        verified: batch.status === 'reconciled',
      }],
    })];
  });
}

async function dataHealthActions(
  bookAccountGuids: string[],
): Promise<FinancialActionCandidate[]> {
  const report = await runDataHealth(bookAccountGuids, { itemCap: 25 });
  return report.checks
    .filter(check => check.count > 0)
    .map(check => sourceAction({
      stableKey: `data-health:${check.id}`,
      lane: 'fix',
      origin: 'data_health',
      sourceId: check.id,
      severity: check.severity === 'error'
        ? 'critical'
        : check.severity === 'warning'
          ? 'warning'
          : 'info',
      title: `${check.label}: ${check.count} issue${check.count === 1 ? '' : 's'}`,
      summary: check.description,
      dueDate: null,
      impact: check.items.some(item => typeof item.amount === 'number')
        ? {
            low: 0,
            high: check.items.reduce((sum, item) => sum + Math.abs(item.amount ?? 0), 0),
            period: 'one_time',
          }
        : null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Open Data Health', kind: 'link', href: '/tools/data-health', primary: true },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      asOfDate: report.generatedAt.slice(0, 10),
      traceResult: check.count,
      evidence: check.items.map(item => ({
        kind: item.href?.startsWith('/transactions/') ? 'transaction' as const : 'account' as const,
        id: item.guid,
        label: item.name,
        source: 'system' as const,
        href: item.href,
        observedAt: report.generatedAt,
        verified: false,
        metadata: { detail: item.detail, amount: item.amount, currency: item.currency },
      })),
      metadata: { healthScore: report.score, healthGrade: report.grade, truncated: check.truncated },
    }));
}

async function insightActions(bookGuid: string): Promise<FinancialActionCandidate[]> {
  const insights = await listInsights(bookGuid, { limit: 50 });
  return insights.map(insight => sourceAction({
    stableKey: `insight:${insight.id}`,
    lane: 'decide',
    origin: 'insight',
    sourceId: String(insight.id),
    severity: insight.severity,
    title: insight.title,
    summary: insight.detail,
    dueDate: null,
    impact: null,
    confidence: 0.85,
    operations: [
      { id: 'review', label: 'Review insight', kind: 'link', href: insight.href, primary: true },
      { id: 'dismiss', label: 'Dismiss', kind: 'state', targetState: 'dismissed' },
    ],
    evidence: [{
      kind: 'report_query',
      id: `insight:${insight.id}`,
      label: insight.kind,
      source: 'system',
      href: insight.href,
      observedAt: insight.createdAt,
    }],
  }));
}

async function complianceActions(
  userId: number,
  bookGuid: string,
): Promise<FinancialActionCandidate[]> {
  const now = new Date();
  const entity = await getEntityProfile(bookGuid, userId);
  const items = [
    ...complianceItemsForYear(entity.entityType, entity.taxState, now.getFullYear(), entity.businessActivity),
    ...complianceItemsForYear(entity.entityType, entity.taxState, now.getFullYear() + 1, entity.businessActivity)
      .filter(item => daysUntil(item.dueDate, now) <= 92),
  ];
  const statuses = await prisma.gnucash_web_compliance_status.findMany({
    where: { book_guid: bookGuid },
  });
  const done = new Set(statuses.map(row => complianceStatusKey(row.item_key, row.period)));
  const standard = items
    .filter(item => !done.has(complianceStatusKey(item.key, item.period)))
    .filter(item => daysUntil(item.dueDate, now) <= 60)
    .map(item => sourceAction({
      stableKey: `compliance:${item.key}:${item.period}`,
      lane: 'do',
      origin: 'compliance',
      sourceId: `${item.key}:${item.period}`,
      severity: severityFromDueDate(item.dueDate),
      title: item.title,
      summary: item.description,
      dueDate: item.dueDate,
      impact: null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Open compliance calendar', kind: 'link', href: `/taxes/compliance?year=${item.dueDate.slice(0, 4)}`, primary: true },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      evidence: [{
        kind: 'tax_table',
        id: `${item.key}:${item.period}`,
        label: item.title,
        source: 'system',
        href: `/taxes/compliance?year=${item.dueDate.slice(0, 4)}`,
        observedAt: isoDate(now),
        verified: false,
      }],
    }));
  const certificateObligations = await getFarmCertificateObligations(bookGuid);
  const certificates = certificateObligations
    .filter(item => daysUntil(item.dueDate, now) <= 90)
    .map(item => sourceAction({
      stableKey: item.key,
      lane: 'do',
      origin: 'compliance',
      sourceId: item.key,
      severity: severityFromDueDate(item.dueDate),
      title: item.title,
      summary: item.description,
      dueDate: item.dueDate,
      impact: null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Open certificate', kind: 'link', href: '/business/documents', primary: true },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      evidence: [{
        kind: 'rule',
        id: item.key,
        label: item.certificateType,
        source: 'manual',
        href: '/business/documents',
        observedAt: isoDate(now),
        verified: true,
      }],
      metadata: {
        documentId: item.documentId,
        certificateType: item.certificateType,
        obligationKind: item.kind,
      },
    }));
  return [...standard, ...certificates];
}

const CLOSE_ITEMS = [
  ['close-reconcile', 'Reconcile bank & credit card accounts', '/statements'],
  ['close-ar', 'Review AR aging', '/business/reports/aging'],
  ['close-ap', 'Review AP aging', '/business/reports/aging'],
  ['close-uncategorized', 'Review uncategorized & imbalanced transactions', '/tools/data-health'],
  ['close-reports', 'Run P&L and Balance Sheet', '/business/close'],
] as const;

async function businessCloseActions(
  userId: number,
  bookGuid: string,
): Promise<FinancialActionCandidate[]> {
  const entity = await getEntityProfile(bookGuid, userId);
  if (entity.entityType === 'household') return [];
  const now = new Date();
  const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = prior.toISOString().slice(0, 7);
  const statuses = await prisma.gnucash_web_compliance_status.findMany({
    where: {
      book_guid: bookGuid,
      period: month,
      item_key: { in: CLOSE_ITEMS.map(item => item[0]) },
    },
  });
  const done = new Set(statuses.map(row => row.item_key));
  return CLOSE_ITEMS
    .filter(([key]) => !done.has(key))
    .map(([key, title, href]) => sourceAction({
      stableKey: `business-close:${month}:${key}`,
      lane: 'do',
      origin: 'business_close',
      sourceId: `${month}:${key}`,
      severity: now.getUTCDate() > 10 ? 'warning' : 'info',
      title,
      summary: `This ${month} close task is still pending.`,
      dueDate: `${now.toISOString().slice(0, 7)}-10`,
      impact: null,
      confidence: 1,
      operations: [
        { id: 'open', label: 'Open close checklist', kind: 'link', href: `/business/close?month=${month}`, primary: true },
        { id: 'detail', label: 'Go to task', kind: 'link', href },
        { id: 'resolve', label: 'Mark resolved', kind: 'state', targetState: 'resolved' },
      ],
      evidence: [{
        kind: 'report_query',
        id: `${month}:${key}`,
        label: title,
        source: 'system',
        href: `/business/close?month=${month}`,
        observedAt: isoDate(now),
        verified: false,
      }],
    }));
}

async function notificationActions(
  userId: number,
  bookGuid: string,
): Promise<FinancialActionCandidate[]> {
  const { notifications } = await listNotifications(userId, bookGuid, 100);
  return notifications
    .filter(notification => notification.readAt === null)
    .map(notification => {
      const failed = notification.severity === 'error'
        || notification.type.includes('failed')
        || notification.type === 'background_job';
      return sourceAction({
        stableKey: `notification:${notification.id}`,
        lane: failed ? 'fix' : 'do',
        origin: failed ? 'failed_job' : 'notification',
        sourceId: String(notification.id),
        severity: notification.severity === 'error'
          ? 'critical'
          : notification.severity === 'success'
            ? 'info'
            : notification.severity,
        title: notification.title,
        summary: notification.message || 'Unread notification needs attention.',
        dueDate: null,
        impact: null,
        confidence: 1,
        operations: [
          ...(notification.href
            ? [{ id: 'open', label: failed ? 'Fix issue' : 'Open', kind: 'link' as const, href: notification.href, primary: true }]
            : []),
          { id: 'resolve', label: 'Mark resolved', kind: 'state' as const, targetState: 'resolved' as const },
        ],
        evidence: [{
          kind: failed ? 'job' : 'notification',
          id: notification.sourceId || String(notification.id),
          label: notification.title,
          source: notification.source === 'simplefin' ? 'simplefin' : 'system',
          href: notification.href || undefined,
          observedAt: notification.createdAt.toISOString(),
          verified: false,
        }],
        metadata: { notificationId: notification.id, notificationType: notification.type },
      });
    });
}

async function safe<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.warn(`Financial Action source “${label}” was unavailable:`, error);
    return fallback;
  }
}

export async function safeActionSource(
  label: string,
  work: () => Promise<FinancialActionCandidate[]>,
): Promise<FinancialActionCandidate[]> {
  try {
    return await work();
  } catch (error) {
    console.warn(`Financial Action source “${label}” was unavailable:`, error);
    const sourceKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return [sourceAction({
      stableKey: `source-adapter-failure:${sourceKey}`,
      lane: 'fix',
      origin: 'failed_job',
      sourceId: sourceKey,
      severity: 'critical',
      title: `${label} actions could not be refreshed`,
      summary: 'This source is temporarily unavailable, so the Action Center may be incomplete.',
      dueDate: null,
      impact: null,
      confidence: 1,
      operations: [{
        id: 'retry',
        label: 'Retry refresh',
        kind: 'link',
        href: '/actions',
        primary: true,
      }],
      evidence: [{
        kind: 'job',
        id: `action-source:${sourceKey}`,
        label: `${label} adapter refresh`,
        source: 'system',
        observedAt: new Date().toISOString(),
        verified: false,
      }],
      metadata: { adapter: label, refreshFailed: true },
    })];
  }
}

export async function loadSourceActions(input: {
  userId: number;
  bookGuid: string;
  bookAccountGuids: string[];
}): Promise<FinancialActionCandidate[]> {
  const { userId, bookGuid, bookAccountGuids } = input;
  const results = await Promise.all([
    safeActionSource('Transaction review', () => transactionReviewActions(bookAccountGuids)),
    safeActionSource('Receipt inbox', () => receiptActions(bookGuid)),
    safeActionSource('Statement reconciliation', () => statementActions(bookGuid)),
    safeActionSource('Data Health', () => dataHealthActions(bookAccountGuids)),
    safeActionSource('Insights', () => insightActions(bookGuid)),
    safeActionSource('Compliance', () => complianceActions(userId, bookGuid)),
    safeActionSource('Business close', () => businessCloseActions(userId, bookGuid)),
    safeActionSource('Notifications and failed jobs', () => notificationActions(userId, bookGuid)),
  ]);
  return results.flat();
}

function moneyFromText(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\$([0-9][0-9,]*(?:\.\d{1,2})?)/);
  if (!match) return null;
  const parsed = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function contributionSignals(
  bookAccountGuids: string[],
  year: number,
): Promise<OpportunitySignal[]> {
  const report = await generateContributionSummary({
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    bookAccountGuids,
  }, 'tax_year', null);
  const period = report.periods.find(item => item.year === year);
  if (!period) return [];
  return Object.entries(period.byAccountType).flatMap(([type, summary]) => {
    if (!summary.irsLimit) return [];
    const remaining = Math.max(0, summary.irsLimit.total - summary.net);
    if (remaining < 250) return [];
    const monthsLeft = Math.max(1, 12 - new Date().getMonth());
    return [{
      key: type,
      title: `Use remaining ${type.replaceAll('_', ' ')} capacity`,
      summary: `${remaining.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} of this year’s tax-advantaged capacity is still available.`,
      href: '/reports/contribution_summary',
      dueDate: `${year}-12-31`,
      valueLow: remaining * 0.12,
      valueHigh: remaining * 0.3,
      impactPeriod: 'annual',
      cashRequired: remaining,
      urgency: Math.min(95, 45 + (12 - monthsLeft) * 5),
      confidence: 0.85,
      liquidityCost: 70,
      reversibility: 45,
      goalAlignment: 75,
      assumptions: ['Tax value uses a 12%–30% marginal benefit range.', 'Confirm plan eligibility and contribution rules before funding.'],
      evidence: [{
        kind: 'report_query',
        id: `contributions:${year}:${type}`,
        label: `${year} contribution summary`,
        source: 'system',
        href: '/reports/contribution_summary',
        observedAt: report.generatedAt,
        verified: true,
      }],
      metadata: { accountType: type, remainingCapacity: remaining },
    }];
  });
}

async function cashAndExpenseSnapshot(bookAccountGuids: string[]): Promise<{
  cash: number;
  monthlyExpenses: number;
}> {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * DAY_MS);
  const baseCurrency = await getBaseCurrency();
  const [cashRows, incomeExpense] = await Promise.all([
    prisma.$queryRaw<Array<{ total: number | null }>>`
      SELECT COALESCE(SUM(balance), 0)::float8 AS total
      FROM (
        SELECT a.guid,
          SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric) AS balance
        FROM accounts a
        LEFT JOIN splits s ON s.account_guid = a.guid
        WHERE a.guid = ANY(${bookAccountGuids}::text[])
          AND a.account_type IN ('BANK', 'CASH')
          AND COALESCE(a.placeholder, 0) = 0
        GROUP BY a.guid
      ) balances
    `,
    FinancialSummaryService.computeIncomeExpenses(
      bookAccountGuids,
      ninetyDaysAgo,
      now,
      baseCurrency,
    ),
  ]);
  return {
    cash: Math.max(0, cashRows[0]?.total ?? 0),
    // Net expense-account activity correctly lets refunds reduce the run rate,
    // and the summary service converts foreign-currency expenses.
    monthlyExpenses: Math.max(0, incomeExpense.totalExpenses / 3),
  };
}

async function debtSignal(
  userId: number,
  bookGuid: string,
  bookAccountGuids: string[],
  cash: number,
  monthlyExpenses: number,
): Promise<OpportunitySignal | null> {
  const rows = await prisma.$queryRaw<Array<{ guid: string; name: string; balance: number | null }>>`
    SELECT a.guid, a.name,
      COALESCE(SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric), 0)::float8 AS balance
    FROM accounts a
    LEFT JOIN splits s ON s.account_guid = a.guid
    WHERE a.guid = ANY(${bookAccountGuids}::text[])
      AND a.account_type IN ('LIABILITY', 'CREDIT', 'PAYABLE')
      AND COALESCE(a.placeholder, 0) = 0
    GROUP BY a.guid, a.name
  `;
  const configRow = await prisma.gnucash_web_tool_config.findFirst({
    where: { user_id: userId, book_guid: bookGuid, tool_type: 'debt-payoff' },
    orderBy: { updated_at: 'desc' },
  });
  const config = (configRow?.config ?? {}) as {
    debts?: Record<string, { apr?: number; include?: boolean }>;
  };
  const debts = rows
    .map(row => ({
      ...row,
      owed: Math.max(0, -(row.balance ?? 0)),
      apr: config.debts?.[row.guid]?.apr ?? 0,
      include: config.debts?.[row.guid]?.include ?? true,
    }))
    .filter(row => row.include && row.owed > 0 && row.apr >= 7)
    .sort((a, b) => b.apr - a.apr);
  const debt = debts[0];
  const reserve = monthlyExpenses * 3;
  const excessCash = Math.max(0, cash - reserve);
  if (!debt || excessCash < 250) return null;
  const paydown = Math.min(debt.owed, excessCash);
  return {
    key: debt.guid,
    title: `Pay down ${debt.name} at ${debt.apr.toFixed(2)}%`,
    summary: `Cash above a three-month reserve could reduce high-interest debt without consuming the emergency floor.`,
    href: '/tools/debt-payoff',
    valueLow: paydown * debt.apr / 100 * 0.75,
    valueHigh: paydown * debt.apr / 100,
    impactPeriod: 'annual',
    cashRequired: paydown,
    urgency: debt.apr >= 15 ? 90 : 72,
    confidence: 0.9,
    liquidityCost: 65,
    reversibility: 25,
    goalAlignment: 80,
    assumptions: ['Keeps three months of observed expenses in cash.', 'Interest avoided assumes the configured APR remains unchanged.'],
    evidence: [
      { kind: 'account', id: debt.guid, label: debt.name, source: 'manual', href: `/accounts/${debt.guid}`, verified: true },
      { kind: 'report_query', id: 'cash-reserve', label: '90-day expense run rate', source: 'system', href: '/dashboard', observedAt: isoDate(new Date()) },
    ],
    metadata: { apr: debt.apr, debtBalance: debt.owed, excessCash, reserve },
  };
}

function emergencySignal(cash: number, monthlyExpenses: number): OpportunitySignal | null {
  if (monthlyExpenses <= 0) return null;
  const floor = monthlyExpenses * 3;
  if (cash >= floor) return null;
  const gap = floor - cash;
  return {
    key: 'three-month-reserve',
    title: 'Restore a three-month cash reserve',
    summary: `Liquid cash covers ${(cash / monthlyExpenses).toFixed(1)} months of recent expenses.`,
    href: '/goals',
    valueLow: gap * 0.02,
    valueHigh: gap * 0.1,
    impactPeriod: 'annual',
    cashRequired: gap,
    urgency: cash < monthlyExpenses ? 95 : 78,
    confidence: 0.9,
    liquidityCost: 15,
    reversibility: 95,
    goalAlignment: 90,
    severity: cash < monthlyExpenses ? 'critical' : 'warning',
    assumptions: ['Monthly expenses use the most recent 90 days.', 'A three-month floor is a planning default, not a universal rule.'],
    evidence: [{
      kind: 'report_query',
      id: 'cash-runway-90d',
      label: 'Cash accounts and 90-day expenses',
      source: 'system',
      href: '/tools/cash-flow-forecast',
      observedAt: isoDate(new Date()),
    }],
    metadata: { cash, monthlyExpenses, targetFunding: floor, fundingGap: gap },
  };
}

async function investmentSignals(
  userId: number,
  bookGuid: string,
  bookAccountGuids: string[],
): Promise<{ portfolio: OpportunitySignal[]; taxStrategy: OpportunitySignal[] }> {
  const report = await generateInvestmentPortfolio(
    { startDate: null, endDate: null, bookAccountGuids },
    false,
  );
  const configRow = await prisma.gnucash_web_tool_config.findFirst({
    where: { user_id: userId, book_guid: bookGuid, tool_type: 'rebalance_targets' },
    orderBy: { updated_at: 'desc' },
  });
  const config = parseRebalanceConfig(configRow?.config);
  const bySymbol = new Map<string, number>();
  for (const holding of report.holdings) {
    bySymbol.set(holding.symbol, (bySymbol.get(holding.symbol) ?? 0) + holding.marketValue);
  }
  const holdings = [...bySymbol].map(([key, currentValue]) => ({
    key,
    label: key,
    currentValue,
  }));
  const rebalance = computeRebalance(holdings, config.targetsBySymbol, { bandPct: config.bandPct });
  const driftDollars = rebalance.suggestions.reduce((sum, item) => sum + Math.abs(item.amount), 0) / 2;
  const portfolio: OpportunitySignal[] = driftDollars >= 500 && config.targetsBySymbol.length > 0
    ? [{
        key: 'target-drift',
        title: 'Review portfolio drift',
        summary: `${driftDollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} is outside the saved allocation targets.`,
        href: '/investments/rebalancing',
        valueLow: 0,
        valueHigh: Math.max(1, driftDollars * 0.02),
        impactPeriod: 'annual',
        cashRequired: 0,
        urgency: 55,
        confidence: 0.9,
        liquidityCost: 35,
        reversibility: 70,
        goalAlignment: 65,
        assumptions: ['Value range estimates a modest 0%–2% annual risk-adjusted benefit.', 'Review taxes and trading costs before selling.'],
        evidence: report.holdings.map(holding => ({
          kind: 'price' as const,
          id: holding.guid,
          label: `${holding.symbol} price`,
          source: 'market_price' as const,
          href: `/accounts/${holding.guid}`,
          observedAt: holding.priceDate,
          stale: holding.priceDate
            ? Date.now() - new Date(`${holding.priceDate}T00:00:00Z`).getTime() > 7 * DAY_MS
            : true,
          metadata: { price: holding.latestPrice, marketValue: holding.marketValue },
        })),
        metadata: { driftDollars, suggestionCount: rebalance.suggestions.length },
      }]
    : [];

  const lossHoldings = report.holdings.filter(holding => holding.gain <= -500);
  const totalLoss = Math.abs(lossHoldings.reduce((sum, holding) => sum + holding.gain, 0));
  const taxStrategy: OpportunitySignal[] = totalLoss >= 500
    ? [{
        key: 'tax-loss-harvest',
        title: 'Review tax-loss harvesting candidates',
        summary: `${lossHoldings.length} holding${lossHoldings.length === 1 ? '' : 's'} show ${totalLoss.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} of unrealized losses.`,
        href: '/reports/tax_harvesting',
        valueLow: totalLoss * 0.12,
        valueHigh: totalLoss * 0.37,
        impactPeriod: 'one_time',
        cashRequired: 0,
        urgency: new Date().getMonth() >= 9 ? 85 : 58,
        confidence: 0.85,
        liquidityCost: 25,
        reversibility: 55,
        goalAlignment: 65,
        assumptions: ['Tax value uses a 12%–37% marginal rate range.', 'Wash-sale rules, holding period, and replacement exposure must be reviewed.'],
        evidence: lossHoldings.map(holding => ({
          kind: 'account' as const,
          id: holding.guid,
          label: `${holding.symbol}: ${holding.gain.toFixed(2)} unrealized`,
          source: 'market_price' as const,
          href: `/accounts/${holding.guid}`,
          observedAt: holding.priceDate,
          stale: holding.priceDate
            ? Date.now() - new Date(`${holding.priceDate}T00:00:00Z`).getTime() > 7 * DAY_MS
            : true,
        })),
        metadata: { totalLoss, holdingCount: lossHoldings.length },
      }]
    : [];
  return { portfolio, taxStrategy };
}

async function subscriptionSignals(bookAccountGuids: string[]): Promise<OpportunitySignal[]> {
  const result = await detectRecurringCharges(bookAccountGuids, { months: 24, minOccurrences: 3 });
  const increases = result.series.filter(series => series.status !== 'stopped' && series.amountChangePct > 5);
  const byAmount = new Map<string, typeof result.series>();
  for (const series of result.series.filter(item => item.status !== 'stopped')) {
    const key = `${series.cadence}:${Math.round(series.currentAmount)}`;
    byAmount.set(key, [...(byAmount.get(key) ?? []), series]);
  }
  const duplicates = [...byAmount.values()].filter(group => group.length > 1);
  return [
    ...increases.map(series => ({
      key: `price-increase:${series.merchantKey}`,
      title: `Review ${series.merchantLabel} price increase`,
      summary: `The latest charge is ${series.amountChangePct.toFixed(1)}% above its earlier typical amount.`,
      href: '/tools/subscriptions',
      dueDate: series.nextExpected,
      valueLow: Math.max(0, series.currentAmount - series.typicalAmount),
      valueHigh: series.monthlyEquivalent * 12,
      impactPeriod: 'annual' as const,
      cashRequired: 0,
      urgency: 60,
      confidence: 0.88,
      liquidityCost: 0,
      reversibility: 90,
      goalAlignment: 60,
      assumptions: ['Annual value assumes the current cadence continues.', 'A price change can reflect a plan change rather than an avoidable increase.'],
      evidence: [{
        kind: 'report_query' as const,
        id: series.merchantKey,
        label: `${series.occurrences} recurring charges`,
        source: 'system' as const,
        href: '/tools/subscriptions',
        observedAt: series.lastSeen,
      }],
      metadata: { merchant: series.merchantLabel, amountChangePct: series.amountChangePct },
    })),
    ...duplicates.map((group, index) => {
      const least = Math.min(...group.map(series => series.monthlyEquivalent));
      return {
        key: `possible-duplicate:${index}:${group.map(item => item.merchantKey).sort().join(':')}`,
        title: 'Review possible duplicate recurring charges',
        summary: group.map(item => item.merchantLabel).join(' and ') + ' have the same cadence and a similar amount.',
        href: '/tools/subscriptions',
        valueLow: least * 6,
        valueHigh: least * 12,
        impactPeriod: 'annual' as const,
        cashRequired: 0,
        urgency: 48,
        confidence: 0.67,
        liquidityCost: 0,
        reversibility: 90,
        goalAlignment: 55,
        assumptions: ['Matching amount and cadence is a duplicate signal, not proof.', 'Confirm the services are redundant before canceling.'],
        evidence: group.map(item => ({
          kind: 'report_query' as const,
          id: item.merchantKey,
          label: item.merchantLabel,
          source: 'system' as const,
          href: '/tools/subscriptions',
          observedAt: item.lastSeen,
        })),
      };
    }),
  ];
}

async function notificationOpportunitySignals(
  userId: number,
  bookGuid: string,
): Promise<{ estimatedTax: OpportunitySignal | null; budgetGaps: OpportunitySignal[] }> {
  const { notifications } = await listNotifications(userId, bookGuid, 200);
  const unread = notifications.filter(item => item.readAt === null);
  const tax = unread.find(item =>
    item.type.includes('estimated_tax') || /safe.?harbor|estimated tax shortfall/i.test(`${item.title} ${item.message}`),
  );
  const taxAmount = tax ? moneyFromText(tax.message) : null;
  const estimatedTax = tax && taxAmount && taxAmount > 0
    ? {
        key: tax.sourceId || String(tax.id),
        title: tax.title,
        summary: tax.message || 'Estimated tax funding needs attention.',
        href: tax.href || '/taxes/estimated',
        valueLow: taxAmount * 0.02,
        valueHigh: taxAmount * 0.08,
        impactPeriod: 'one_time' as const,
        cashRequired: taxAmount,
        urgency: 90,
        confidence: 0.9,
        liquidityCost: 80,
        reversibility: 20,
        goalAlignment: 90,
        severity: 'warning' as const,
        assumptions: ['Value range estimates avoided underpayment penalties and interest.', 'Confirm the safe-harbor calculation before paying.'],
        metadata: { taxShortfall: taxAmount },
        evidence: [{
          kind: 'notification' as const,
          id: String(tax.id),
          label: tax.title,
          source: 'system' as const,
          href: tax.href || undefined,
          observedAt: tax.createdAt.toISOString(),
        }],
      }
    : null;
  const budgetGaps = unread
    .filter(item => item.type.includes('budget') || item.source === 'budget-envelope')
    .flatMap(item => {
      const amount = moneyFromText(item.message);
      if (!amount || amount <= 0) return [];
      return [{
        key: item.sourceId || String(item.id),
        title: item.title,
        summary: item.message || 'A known obligation is not fully funded.',
        href: item.href || '/budgets',
        valueLow: amount * 0.01,
        valueHigh: amount * 0.05,
        impactPeriod: 'one_time' as const,
        cashRequired: amount,
        urgency: item.severity === 'error' ? 90 : 72,
        confidence: 0.85,
        liquidityCost: 55,
        reversibility: 75,
        goalAlignment: 80,
        assumptions: ['Funding gap is taken from the existing deterministic budget alert.'],
        metadata: { fundingGap: amount },
        evidence: [{
          kind: 'notification' as const,
          id: String(item.id),
          label: item.title,
          source: 'system' as const,
          href: item.href || undefined,
          observedAt: item.createdAt.toISOString(),
        }],
      }];
    });
  return { estimatedTax, budgetGaps };
}

export async function loadOpportunityActions(input: {
  userId: number;
  bookGuid: string;
  bookAccountGuids: string[];
}): Promise<FinancialActionCandidate[]> {
  const { userId, bookGuid, bookAccountGuids } = input;
  const now = new Date();
  const cash = await safe('cash and expense snapshot', () => cashAndExpenseSnapshot(bookAccountGuids), {
    cash: 0,
    monthlyExpenses: 0,
  });
  const [contributionCapacity, debtPaydown, investments, subscriptions, notifications] = await Promise.all([
    safe('contribution opportunity', () => contributionSignals(bookAccountGuids, now.getFullYear()), []),
    safe('debt opportunity', () => debtSignal(
      userId,
      bookGuid,
      bookAccountGuids,
      cash.cash,
      cash.monthlyExpenses,
    ), null),
    safe('investment opportunities', () => investmentSignals(userId, bookGuid, bookAccountGuids), {
      portfolio: [],
      taxStrategy: [],
    }),
    safe('subscription opportunities', () => subscriptionSignals(bookAccountGuids), []),
    safe('tax and budget opportunities', () => notificationOpportunitySignals(userId, bookGuid), {
      estimatedTax: null,
      budgetGaps: [],
    }),
  ]);
  const snapshot: OpportunitySnapshot = {
    asOfDate: isoDate(now),
    estimatedTax: notifications.estimatedTax,
    contributionCapacity,
    debtPaydown,
    emergencyFund: emergencySignal(cash.cash, cash.monthlyExpenses),
    portfolio: investments.portfolio,
    taxStrategy: investments.taxStrategy,
    subscriptions,
    budgetGaps: notifications.budgetGaps,
  };
  return detectOpportunities(snapshot);
}
