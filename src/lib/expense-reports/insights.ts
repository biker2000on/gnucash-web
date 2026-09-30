/**
 * Owner expense reports — what needs attention, for the Action Center and
 * the Money Timeline, plus drift and reconciliation checks.
 *
 * Signals are computed per book, for each book link the book is on either
 * side of: a household sees unreported charges, settlements to record and
 * drift in its charges; a business sees reports to categorize, approve and
 * pay, and vouchers that were unposted behind the workflow's back.
 */

import prisma from '@/lib/prisma';
import { getLinksForBusinessBook, getLinksToHouseholdBook } from '@/lib/services/book-links.service';
import {
  formatCents,
  formatReportNumber,
  receivableDifferenceCents,
  remainderCents,
  type ReportStatus,
} from './model';
import { getSettings } from './shared';
import { sinceDate } from './household';

export type SignalKind =
  | 'unreported'
  | 'household_settlement'
  | 'drift_split'
  | 'reconciliation'
  | 'awaiting_approval'
  | 'approved_unpaid'
  | 'drift_voucher'
  | 'late_lines';

export interface ExpenseReportSignal {
  key: string;
  kind: SignalKind;
  lane: 'fix' | 'decide' | 'do';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  href: string;
  amountCents: number | null;
  dueDate: string | null;
  reportId: number | null;
}

interface LiveLineRow {
  report_id: number;
  number: number;
  status: string;
  source_split_guid: string;
  amount: string;
  late: boolean;
  expense_account_guid: string | null;
}

function cents(v: string | number | bigint): number {
  return Math.round(Number(v) * 100);
}

async function householdSignals(householdBookGuid: string, businessBookGuid: string, businessName: string): Promise<ExpenseReportSignal[]> {
  const settings = await getSettings(businessBookGuid, householdBookGuid);
  if (!settings.reimbursableAccountGuid) return [];
  const signals: ExpenseReportSignal[] = [];
  const receivable = settings.reimbursableAccountGuid;

  // Only activity since the reporting cutoff: older charges on the account
  // (and their manual reimbursements) predate the workflow.
  const splits = await prisma.$queryRaw<Array<{ guid: string; value_num: bigint; value_denom: bigint }>>`
    SELECT s.guid, s.value_num, s.value_denom
      FROM splits s JOIN transactions t ON t.guid = s.tx_guid
     WHERE s.account_guid = ${receivable} AND t.post_date >= ${sinceDate(settings.reportSince)}
  `;
  const lines = await prisma.$queryRaw<LiveLineRow[]>`
    SELECT r.id AS report_id, r.number, r.status, l.source_split_guid, l.amount::text AS amount, l.late,
           l.expense_account_guid
      FROM gnucash_web_expense_report_lines l
      JOIN gnucash_web_expense_reports r ON r.id = l.report_id
     WHERE l.household_book_guid = ${householdBookGuid}
       AND l.business_book_guid = ${businessBookGuid}
       AND l.kind = 'business'
       AND r.status IN ('submitted', 'posted', 'paid', 'settled')
  `;
  const bySplit = new Map<string, LiveLineRow[]>();
  for (const l of lines) bySplit.set(l.source_split_guid, [...(bySplit.get(l.source_split_guid) ?? []), l]);
  const splitValue = new Map(splits.map((s) => [s.guid, Math.round((Number(s.value_num) * 100) / Number(s.value_denom))]));

  let unreported = 0;
  let balance = 0;
  for (const [guid, value] of splitValue) {
    balance += value;
    if (value <= 0) continue;
    unreported += remainderCents(
      value,
      (bySplit.get(guid) ?? []).map((l) => ({ kind: 'business' as const, amountCents: cents(l.amount), reportStatus: l.status as ReportStatus })),
    );
  }
  if (unreported > 0) {
    signals.push({
      key: `expense-report:unreported:${businessBookGuid}`,
      kind: 'unreported',
      lane: 'do',
      severity: 'info',
      title: `${formatCents(unreported)} of ${businessName} expenses not yet reported`,
      summary: `Charges on the reimbursable account that are not on an expense report yet. Report them so ${businessName} can reimburse you.`,
      href: `/expense-reports?business=${businessBookGuid}`,
      amountCents: unreported,
      dueDate: null,
      reportId: null,
    });
  }

  // Drift: a reported charge was deleted, moved, or re-amounted below what
  // live reports already claim from it.
  const drifted: string[] = [];
  for (const [guid, rows] of bySplit) {
    const claimed = rows.reduce((s, l) => s + cents(l.amount), 0);
    const value = splitValue.get(guid);
    if (value === undefined || value < claimed) drifted.push(guid);
  }
  if (drifted.length > 0) {
    const numbers = [...new Set(drifted.flatMap((g) => bySplit.get(g)!.map((l) => formatReportNumber(l.number))))];
    signals.push({
      key: `expense-report:drift-split:${householdBookGuid}:${businessBookGuid}`,
      kind: 'drift_split',
      lane: 'fix',
      severity: 'warning',
      title: `${drifted.length} reported charge${drifted.length === 1 ? ' was' : 's were'} changed after reporting`,
      summary: `A charge on ${numbers.join(', ')} was edited, deleted, moved off the reimbursable account, or reduced below the amount already reported. Review the charge and the report.`,
      href: `/expense-reports?business=${businessBookGuid}`,
      amountCents: null,
      dueDate: null,
      reportId: null,
    });
  }

  // Reported but not yet settled on the household side.
  const unsettled = new Map<number, { number: number; status: string; cents: number }>();
  for (const l of lines) {
    if (l.status === 'settled') continue;
    const entry = unsettled.get(l.report_id) ?? { number: l.number, status: l.status, cents: 0 };
    entry.cents += cents(l.amount);
    unsettled.set(l.report_id, entry);
  }
  for (const [reportId, r] of unsettled) {
    if (r.status !== 'paid') continue;
    signals.push({
      key: `expense-report:settle:${reportId}`,
      kind: 'household_settlement',
      lane: 'do',
      severity: 'warning',
      title: `Record the ${formatReportNumber(r.number)} reimbursement`,
      summary: `${businessName} paid ${formatCents(r.cents)}. Match the deposit (or record it) so the reimbursable account clears.`,
      href: `/expense-reports?report=${reportId}`,
      amountCents: r.cents,
      dueDate: null,
      reportId,
    });
  }

  const reportedUnsettled = [...unsettled.values()].reduce((s, r) => s + r.cents, 0);
  const difference = receivableDifferenceCents({ receivableBalanceCents: balance, unreportedCents: unreported, reportedUnsettledCents: reportedUnsettled });
  if (difference !== 0) {
    signals.push({
      key: `expense-report:reconcile:${householdBookGuid}:${businessBookGuid}`,
      kind: 'reconciliation',
      lane: 'fix',
      severity: 'info',
      title: `Reimbursable account is off by ${formatCents(difference)}`,
      summary: `The ${businessName} reimbursable account balance does not equal unreported charges plus reports awaiting settlement. Something was recorded outside expense reports (a manual reimbursement or an edited charge).`,
      href: `/expense-reports?business=${businessBookGuid}`,
      amountCents: difference,
      dueDate: null,
      reportId: null,
    });
  }
  return signals;
}

async function businessSignals(businessBookGuid: string): Promise<ExpenseReportSignal[]> {
  const signals: ExpenseReportSignal[] = [];
  const reports = await prisma.$queryRaw<Array<{
    id: number;
    number: number;
    status: string;
    submitted_at: Date;
    total: string;
    uncategorized: bigint;
    late: bigint;
    voucher_posted: boolean | null;
  }>>`
    SELECT r.id, r.number, r.status, r.submitted_at,
           COALESCE(SUM(l.amount), 0)::text AS total,
           COUNT(*) FILTER (WHERE l.expense_account_guid IS NULL) AS uncategorized,
           COUNT(*) FILTER (WHERE l.late) AS late,
           (SELECT i.post_txn IS NOT NULL FROM invoices i WHERE i.guid = r.voucher_guid) AS voucher_posted
      FROM gnucash_web_expense_reports r
      LEFT JOIN gnucash_web_expense_report_lines l ON l.report_id = r.id
     WHERE r.business_book_guid = ${businessBookGuid}
       AND r.status IN ('submitted', 'posted', 'paid')
     GROUP BY r.id
     ORDER BY r.number
  `;
  for (const r of reports) {
    const label = formatReportNumber(r.number);
    const total = cents(r.total);
    const uncategorized = Number(r.uncategorized);
    if (r.status === 'submitted') {
      signals.push({
        key: `expense-report:approve:${r.id}`,
        kind: 'awaiting_approval',
        lane: 'do',
        severity: 'info',
        title: uncategorized > 0
          ? `Categorize ${uncategorized} line${uncategorized === 1 ? '' : 's'} on ${label}`
          : `Report ${label} awaiting approval`,
        summary: `${formatCents(total)} of owner-paid expenses${uncategorized > 0 ? `; ${uncategorized} still need an expense account before it can be approved` : ' ready to approve'}.`,
        href: `/expense-reports?report=${r.id}`,
        amountCents: total,
        dueDate: null,
        reportId: r.id,
      });
    }
    if (r.status === 'posted') {
      signals.push({
        key: `expense-report:pay:${r.id}`,
        kind: 'approved_unpaid',
        lane: 'do',
        severity: 'info',
        title: `Report ${label} approved, unpaid`,
        summary: `${formatCents(total)} is owed to the owner. Pay it from the business account.`,
        href: `/expense-reports?report=${r.id}`,
        amountCents: total,
        dueDate: null,
        reportId: r.id,
      });
    }
    if ((r.status === 'posted' || r.status === 'paid') && r.voucher_posted === false) {
      signals.push({
        key: `expense-report:drift-voucher:${r.id}`,
        kind: 'drift_voucher',
        lane: 'fix',
        severity: 'warning',
        title: `The voucher for ${label} was unposted`,
        summary: `${label} is marked approved, but its voucher is no longer posted, so the expenses are missing from the books. Repost the voucher.`,
        href: `/business/vouchers`,
        amountCents: total,
        dueDate: null,
        reportId: r.id,
      });
    }
    if (Number(r.late) > 0) {
      signals.push({
        key: `expense-report:late:${r.id}`,
        kind: 'late_lines',
        lane: 'decide',
        severity: 'warning',
        title: `${label} has ${Number(r.late)} line${Number(r.late) === 1 ? '' : 's'} past the accountable-plan deadline`,
        summary: 'Expenses submitted after the deadline may have to be treated as taxable wages rather than a tax-free reimbursement. Confirm the treatment with your tax preparer.',
        href: `/expense-reports?report=${r.id}`,
        amountCents: null,
        dueDate: null,
        reportId: r.id,
      });
    }
  }
  return signals;
}

/** Every expense-report signal for `bookGuid`, whichever side of a link it is on. */
export async function expenseReportSignals(bookGuid: string): Promise<ExpenseReportSignal[]> {
  const [asHousehold, asBusiness] = await Promise.all([
    getLinksToHouseholdBook(bookGuid),
    getLinksForBusinessBook(bookGuid),
  ]);
  const signals: ExpenseReportSignal[] = [];
  for (const link of asHousehold) {
    signals.push(
      ...(await householdSignals(bookGuid, link.businessBookGuid, link.businessEntityName ?? link.businessBookName ?? 'the business')),
    );
  }
  if (asBusiness.length > 0) signals.push(...(await businessSignals(bookGuid)));
  return signals;
}

export interface ExpenseReportEvent {
  reportId: number;
  label: string;
  date: string;
  /** Positive inflow (household), negative outflow (business). */
  cents: number;
  title: string;
  status: ReportStatus;
}

/**
 * Money Timeline: an approved, unpaid report is a dated obligation — money
 * out of the business, and the expected reimbursement into the household.
 * The date is the voucher's due date (approval + 30 days when none).
 */
export async function expenseReportEvents(bookGuid: string): Promise<ExpenseReportEvent[]> {
  const rows = await prisma.$queryRaw<Array<{
    id: number;
    number: number;
    status: string;
    business_book_guid: string;
    household_book_guid: string;
    approved_at: Date | null;
    due: Date | null;
    total: string;
  }>>`
    SELECT r.id, r.number, r.status, r.business_book_guid, r.household_book_guid, r.approved_at,
           (SELECT s.timespec_val FROM invoices i
              JOIN slots s ON s.obj_guid = i.post_txn AND s.name = 'trans-date-due'
             WHERE i.guid = r.voucher_guid LIMIT 1) AS due,
           (SELECT COALESCE(SUM(l.amount), 0) FROM gnucash_web_expense_report_lines l WHERE l.report_id = r.id)::text AS total
      FROM gnucash_web_expense_reports r
     WHERE r.status = 'posted'
       AND (r.business_book_guid = ${bookGuid} OR r.household_book_guid = ${bookGuid})
  `;
  return rows.map((r) => {
    const approved = r.approved_at ?? new Date();
    const date = (r.due ?? new Date(approved.getTime() + 30 * 86_400_000)).toISOString().slice(0, 10);
    const total = cents(r.total);
    const isBusiness = r.business_book_guid === bookGuid;
    return {
      reportId: r.id,
      label: formatReportNumber(r.number),
      date,
      cents: isBusiness ? -total : total,
      title: isBusiness
        ? `Reimburse the owner: ${formatReportNumber(r.number)}`
        : `Expected reimbursement: ${formatReportNumber(r.number)}`,
      status: r.status as ReportStatus,
    };
  });
}
