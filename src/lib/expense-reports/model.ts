/**
 * Owner expense reports — pure model. No database, no Next.js imports, so
 * it is safe for client components and fully unit-testable.
 *
 * All money is integer CENTS. Household charges are debits (positive split
 * values) on the configured reimbursable receivable.
 */

import type { TaxClassification } from '@/lib/entity-status';

export type SettlementMode = 'reimburse' | 'contribution';

/**
 * submitted → posted (approved; voucher posted to A/P) → paid (business paid
 * the owner) → settled (household side recorded). Contribution mode goes
 * submitted → settled in one step. rejected/withdrawn release the lines.
 */
export type ReportStatus = 'submitted' | 'posted' | 'paid' | 'settled' | 'rejected' | 'withdrawn';

export const REPORT_STATUSES: ReportStatus[] = [
  'submitted',
  'posted',
  'paid',
  'settled',
  'rejected',
  'withdrawn',
];

/** Statuses whose lines still claim their share of a household charge. */
export const ALLOCATING_STATUSES: ReadonlySet<ReportStatus> = new Set([
  'submitted',
  'posted',
  'paid',
  'settled',
]);

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  submitted: 'Awaiting approval',
  posted: 'Approved, unpaid',
  paid: 'Paid',
  settled: 'Settled',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function formatReportNumber(n: number): string {
  return `ER-${n}`;
}

export function toCents(value: number | string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return Math.round(n * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Allocation                                                          */
/* ------------------------------------------------------------------ */

export interface AllocationRow {
  kind: 'business' | 'personal';
  amountCents: number;
  /** Null for personal rows. */
  reportStatus: ReportStatus | null;
}

/** Cents of a split already claimed by live report lines. */
export function allocatedCents(rows: readonly AllocationRow[]): number {
  return rows
    .filter((r) => r.kind === 'business' && r.reportStatus !== null && ALLOCATING_STATUSES.has(r.reportStatus))
    .reduce((sum, r) => sum + r.amountCents, 0);
}

/**
 * What is left to report on a split. Personal portions are not subtracted
 * here: marking a portion personal rewrites the ledger, so the split's
 * CURRENT value already excludes it.
 */
export function remainderCents(splitValueCents: number, rows: readonly AllocationRow[]): number {
  return Math.max(0, splitValueCents - allocatedCents(rows));
}

/** Null when `requestedCents` may be allocated from the split, else why not. */
export function allocationError(
  splitValueCents: number,
  rows: readonly AllocationRow[],
  requestedCents: number,
): string | null {
  if (!Number.isInteger(requestedCents) || requestedCents <= 0) {
    return 'The amount must be greater than zero.';
  }
  if (splitValueCents <= 0) return 'Only charges (debits) on the reimbursable account can be reported.';
  const remaining = remainderCents(splitValueCents, rows);
  if (requestedCents > remaining) {
    return `Only ${formatCents(remaining)} of this ${formatCents(splitValueCents)} charge is left to report.`;
  }
  return null;
}

/** Cents for a percentage of a base amount (rounded to the cent). */
export function percentOf(baseCents: number, percent: number): number {
  return Math.round((baseCents * percent) / 100);
}

/* ------------------------------------------------------------------ */
/* Accountable plan                                                    */
/* ------------------------------------------------------------------ */

/**
 * S- and C-corporations only deduct an owner-employee's personally paid
 * expenses when they reimburse them under an accountable plan. A disregarded
 * entity (Schedule C) deducts them whoever paid.
 */
export function requiresAccountablePlan(taxClassification: TaxClassification): boolean {
  return taxClassification === 's_corp' || taxClassification === 'c_corp';
}

export interface AccountablePlanInput {
  taxClassification: TaxClassification;
  /** ISO YYYY-MM-DD. */
  expenseDate: string;
  /** ISO YYYY-MM-DD the line is (being) submitted. */
  submittedDate: string;
  hasReceipt: boolean;
  businessPurpose: string | null | undefined;
  deadlineDays: number;
}

export interface AccountablePlanResult {
  required: boolean;
  /** Evidence still missing; submission is refused while non-empty. */
  missing: Array<'receipt' | 'business_purpose'>;
  /** Submitted after the deadline — may have to be treated as wages. */
  late: boolean;
  daysSinceExpense: number;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function evaluateAccountablePlan(input: AccountablePlanInput): AccountablePlanResult {
  const daysSinceExpense = daysBetween(input.expenseDate, input.submittedDate);
  if (!requiresAccountablePlan(input.taxClassification)) {
    return { required: false, missing: [], late: false, daysSinceExpense };
  }
  const missing: AccountablePlanResult['missing'] = [];
  if (!input.hasReceipt) missing.push('receipt');
  if (!input.businessPurpose || !input.businessPurpose.trim()) missing.push('business_purpose');
  return { required: true, missing, late: daysSinceExpense > input.deadlineDays, daysSinceExpense };
}

/* ------------------------------------------------------------------ */
/* Categorization                                                      */
/* ------------------------------------------------------------------ */

export interface CategorySuggestion {
  accountGuid: string;
  /** 'rule:<id>' | 'history' */
  categorizedBy: string;
}

/**
 * A categorization rule wins over history; history needs a clear favourite
 * (the most frequent account, and more than any runner-up).
 */
export function chooseSuggestion(input: {
  rule: { id: number; accountGuid: string } | null;
  history: ReadonlyArray<{ accountGuid: string; count: number }>;
}): CategorySuggestion | null {
  if (input.rule) return { accountGuid: input.rule.accountGuid, categorizedBy: `rule:${input.rule.id}` };
  const sorted = [...input.history].sort((a, b) => b.count - a.count);
  if (sorted.length === 0 || sorted[0].count <= 0) return null;
  if (sorted.length > 1 && sorted[1].count === sorted[0].count) return null;
  return { accountGuid: sorted[0].accountGuid, categorizedBy: 'history' };
}

export function describeCategorizedBy(value: string | null): string {
  if (!value) return 'Uncategorized';
  if (value.startsWith('rule:')) return 'Rule';
  if (value === 'history') return 'Payee history';
  return 'Manual';
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

export interface ApprovalLine {
  id: number;
  amountCents: number;
  expenseAccountGuid: string | null;
  accountablePlan: boolean;
  missingEvidence: boolean;
}

/** Everything that stops a report from being approved; empty = approvable. */
export function approvalBlockers(lines: readonly ApprovalLine[], mode: SettlementMode): string[] {
  const blockers: string[] = [];
  if (lines.length === 0) blockers.push('The report has no lines.');
  const uncategorized = lines.filter((l) => !l.expenseAccountGuid).length;
  if (uncategorized > 0) {
    blockers.push(`${uncategorized} line${uncategorized === 1 ? ' is' : 's are'} still uncategorized.`);
  }
  const missing = lines.filter((l) => l.missingEvidence).length;
  if (missing > 0) {
    blockers.push(
      `${missing} line${missing === 1 ? ' needs' : 's need'} a receipt and business purpose (accountable plan).`,
    );
  }
  if (mode === 'contribution' && lines.some((l) => l.accountablePlan)) {
    blockers.push(
      'Lines dated while the business is taxed as a corporation must be reimbursed under the accountable plan; treating them as a capital contribution would forfeit the deduction.',
    );
  }
  return blockers;
}

/* ------------------------------------------------------------------ */
/* Transaction plans                                                   */
/* ------------------------------------------------------------------ */

export interface PlannedSplit {
  accountGuid: string;
  /** Positive = debit, negative = credit. */
  cents: number;
  memo: string;
}

export interface CategorizedLine {
  amountCents: number;
  expenseAccountGuid: string;
  description: string;
}

/** Sum debits per expense account (stable order) — the approval preview. */
export function summarizeByAccount(lines: readonly CategorizedLine[]): Array<{ accountGuid: string; cents: number; lines: number }> {
  const map = new Map<string, { accountGuid: string; cents: number; lines: number }>();
  for (const line of lines) {
    const entry = map.get(line.expenseAccountGuid) ?? { accountGuid: line.expenseAccountGuid, cents: 0, lines: 0 };
    entry.cents += line.amountCents;
    entry.lines += 1;
    map.set(line.expenseAccountGuid, entry);
  }
  return [...map.values()];
}

/** Business side of a capital-contribution settlement: debit expenses, credit equity. */
export function contributionSplits(
  lines: readonly CategorizedLine[],
  contributionAccountGuid: string,
  reportLabel: string,
): PlannedSplit[] {
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return [
    ...lines.map((l) => ({ accountGuid: l.expenseAccountGuid, cents: l.amountCents, memo: l.description })),
    { accountGuid: contributionAccountGuid, cents: -total, memo: `Owner contribution — ${reportLabel}` },
  ];
}

/** Household side: move the receivable to `counterAccountGuid` (cash received or investment). */
export function householdSettlementSplits(
  receivableAccountGuid: string,
  counterAccountGuid: string,
  totalCents: number,
  reportLabel: string,
): PlannedSplit[] {
  return [
    { accountGuid: counterAccountGuid, cents: totalCents, memo: reportLabel },
    { accountGuid: receivableAccountGuid, cents: -totalCents, memo: reportLabel },
  ];
}

export function isBalanced(splits: readonly PlannedSplit[]): boolean {
  return splits.reduce((s, x) => s + x.cents, 0) === 0;
}

/* ------------------------------------------------------------------ */
/* Status badge                                                        */
/* ------------------------------------------------------------------ */

export interface SplitAllocationView {
  kind: 'business' | 'personal';
  amountCents: number;
  reportNumber: number | null;
  reportStatus: ReportStatus | null;
  /** ISO date the business paid (paid/settled reports). */
  paidOn: string | null;
}

/**
 * The household ledger badge: 'Reported · ER-3 · Paid 2026-10-05' for a fully
 * reported charge, '$40.00 of $62.22 on ER-3 · $22.22 personal' for a partly
 * reported one, null when nothing is allocated.
 */
export function describeSplitAllocation(
  currentSplitCents: number,
  rows: readonly SplitAllocationView[],
): string | null {
  const live = rows.filter(
    (r) => r.kind === 'business' && r.reportStatus !== null && ALLOCATING_STATUSES.has(r.reportStatus),
  );
  const personal = rows.filter((r) => r.kind === 'personal').reduce((s, r) => s + r.amountCents, 0);
  if (live.length === 0 && personal === 0) return null;

  const reported = live.reduce((s, r) => s + r.amountCents, 0);
  const original = currentSplitCents + personal;
  const numbers = [...new Set(live.map((r) => r.reportNumber).filter((n): n is number => n !== null))]
    .sort((a, b) => a - b)
    .map(formatReportNumber);
  const unallocated = currentSplitCents - reported;

  if (personal === 0 && unallocated <= 0 && live.length > 0) {
    const statuses = live.map((r) => r.reportStatus!);
    const paidDates = live.map((r) => r.paidOn).filter((d): d is string => d !== null).sort();
    const allPaid = statuses.every((s) => s === 'paid' || s === 'settled');
    const state = allPaid
      ? `Paid ${paidDates[paidDates.length - 1] ?? ''}`.trim()
      : statuses.some((s) => s === 'posted' || s === 'paid' || s === 'settled')
        ? 'Approved'
        : 'Submitted';
    return `Reported · ${numbers.join(', ')} · ${state}`;
  }

  const parts: string[] = [];
  if (reported > 0) parts.push(`${formatCents(reported)} of ${formatCents(original)} on ${numbers.join(', ')}`);
  if (personal > 0) parts.push(`${formatCents(personal)} personal`);
  if (unallocated > 0 && reported > 0) parts.push(`${formatCents(unallocated)} unreported`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/**
 * The household receivable should equal what is still unreported plus what
 * has been reported but not yet settled on the household side. A non-zero
 * difference means something moved outside the workflow (a manual entry, an
 * edited charge, a deleted settlement).
 */
export function receivableDifferenceCents(input: {
  receivableBalanceCents: number;
  unreportedCents: number;
  reportedUnsettledCents: number;
}): number {
  return input.receivableBalanceCents - input.unreportedCents - input.reportedUnsettledCents;
}
