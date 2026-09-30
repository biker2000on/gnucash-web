/**
 * Owner expense reports — shared server helpers: errors, cross-book
 * authorization, per-link settings, and report loading.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { hasTargetBookRole, type AuthorizedBookContext } from '@/lib/target-book-auth';
import { withDatabaseAdvisoryLock } from '@/lib/db';
import { isEntityOwnedByBook } from '@/lib/business/entity-ownership';
import { formatReportNumber, type ReportStatus, type SettlementMode } from './model';

export class ExpenseReportError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

export type ExpenseReportContext = AuthorizedBookContext;

/** Require `edit` on a book other than (or the same as) the active one. */
export async function requireBookEdit(ctx: ExpenseReportContext, bookGuid: string, label: string): Promise<void> {
  if (!(await hasTargetBookRole(ctx, bookGuid, 'edit'))) {
    throw new ExpenseReportError(`You need edit access to the ${label} book for this step.`, 403);
  }
}

export async function requireBookRead(ctx: ExpenseReportContext, bookGuid: string, label: string): Promise<void> {
  if (!(await hasTargetBookRole(ctx, bookGuid, 'readonly'))) {
    throw new ExpenseReportError(`You need access to the ${label} book.`, 403);
  }
}

/** The (business, household) pair must be an existing book link. */
export async function assertBookLink(businessBookGuid: string, householdBookGuid: string): Promise<void> {
  const link = await prisma.gnucash_web_book_links.findUnique({
    where: {
      business_book_guid_household_book_guid: {
        business_book_guid: businessBookGuid,
        household_book_guid: householdBookGuid,
      },
    },
  });
  if (!link) throw new ExpenseReportError('These books are not linked. Link them in Settings → Linked household books.', 404);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface ExpenseReportSettings {
  businessBookGuid: string;
  householdBookGuid: string;
  reimbursableAccountGuid: string | null;
  employeeGuid: string | null;
  settlementMode: SettlementMode;
  contributionAccountGuid: string | null;
  householdInvestmentAccountGuid: string | null;
  householdDepositAccountGuid: string | null;
  paymentAccountGuid: string | null;
  submissionDeadlineDays: number;
  /** Charges dated before this (ISO) are ignored; null = all charges. */
  reportSince: string | null;
  /** True when a settings row exists. */
  saved: boolean;
}

export async function getSettings(businessBookGuid: string, householdBookGuid: string): Promise<ExpenseReportSettings> {
  const row = await prisma.gnucash_web_expense_report_settings.findUnique({
    where: {
      business_book_guid_household_book_guid: {
        business_book_guid: businessBookGuid,
        household_book_guid: householdBookGuid,
      },
    },
  });
  return {
    businessBookGuid,
    householdBookGuid,
    reimbursableAccountGuid: row?.reimbursable_account_guid ?? null,
    employeeGuid: row?.employee_guid ?? null,
    settlementMode: row?.settlement_mode === 'contribution' ? 'contribution' : 'reimburse',
    contributionAccountGuid: row?.contribution_account_guid ?? null,
    householdInvestmentAccountGuid: row?.household_investment_account_guid ?? null,
    householdDepositAccountGuid: row?.household_deposit_account_guid ?? null,
    paymentAccountGuid: row?.payment_account_guid ?? null,
    submissionDeadlineDays: row?.submission_deadline_days ?? 60,
    reportSince: row?.report_since ? row.report_since.toISOString().slice(0, 10) : null,
    saved: row !== null,
  };
}

export interface SaveSettingsInput {
  reimbursableAccountGuid?: string | null;
  employeeGuid?: string | null;
  settlementMode?: SettlementMode;
  contributionAccountGuid?: string | null;
  householdInvestmentAccountGuid?: string | null;
  householdDepositAccountGuid?: string | null;
  paymentAccountGuid?: string | null;
  submissionDeadlineDays?: number;
  /** ISO date or null to clear. */
  reportSince?: string | null;
}

async function assertAccountType(
  bookGuid: string,
  accountGuid: string | null | undefined,
  allowed: readonly string[],
  label: string,
): Promise<void> {
  if (!accountGuid) return;
  const inBook = new Set(await getAccountGuidsForBook(bookGuid));
  const account = await prisma.accounts.findUnique({
    where: { guid: accountGuid },
    select: { account_type: true, placeholder: true },
  });
  if (!account || !inBook.has(accountGuid)) {
    throw new ExpenseReportError(`The ${label} account is not in the right book.`);
  }
  if (!allowed.includes(account.account_type)) {
    throw new ExpenseReportError(`The ${label} account must be of type ${allowed.join(' or ')}.`);
  }
  if (account.placeholder) {
    throw new ExpenseReportError(`The ${label} account is a placeholder and cannot hold transactions.`);
  }
}

/**
 * Save link settings. The household fields need edit on the household book,
 * the business fields edit on the business book — the owner usually has both.
 */
export async function saveSettings(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  householdBookGuid: string,
  input: SaveSettingsInput,
): Promise<ExpenseReportSettings> {
  await assertBookLink(businessBookGuid, householdBookGuid);
  const touchesHousehold =
    input.reimbursableAccountGuid !== undefined ||
    input.reportSince !== undefined ||
    input.householdInvestmentAccountGuid !== undefined ||
    input.householdDepositAccountGuid !== undefined;
  const touchesBusiness =
    input.employeeGuid !== undefined ||
    input.settlementMode !== undefined ||
    input.contributionAccountGuid !== undefined ||
    input.paymentAccountGuid !== undefined ||
    input.submissionDeadlineDays !== undefined;
  if (touchesHousehold) await requireBookEdit(ctx, householdBookGuid, 'household');
  if (touchesBusiness) await requireBookEdit(ctx, businessBookGuid, 'business');

  await assertAccountType(householdBookGuid, input.reimbursableAccountGuid, ['RECEIVABLE', 'ASSET'], 'reimbursable');
  await assertAccountType(householdBookGuid, input.householdInvestmentAccountGuid, ['EQUITY', 'ASSET'], 'owner investment');
  await assertAccountType(householdBookGuid, input.householdDepositAccountGuid, ['BANK', 'CASH', 'ASSET'], 'deposit');
  await assertAccountType(businessBookGuid, input.contributionAccountGuid, ['EQUITY'], 'owner contribution');
  await assertAccountType(businessBookGuid, input.paymentAccountGuid, ['BANK', 'CASH', 'CREDIT'], 'payment');
  if (input.employeeGuid && !(await isEntityOwnedByBook('employee', input.employeeGuid, businessBookGuid))) {
    throw new ExpenseReportError('The employee record is not in the business book.');
  }
  if (input.settlementMode && input.settlementMode !== 'reimburse' && input.settlementMode !== 'contribution') {
    throw new ExpenseReportError('Settlement mode must be reimburse or contribution.');
  }
  if (
    input.submissionDeadlineDays !== undefined &&
    (!Number.isInteger(input.submissionDeadlineDays) || input.submissionDeadlineDays < 1 || input.submissionDeadlineDays > 365)
  ) {
    throw new ExpenseReportError('The submission deadline must be between 1 and 365 days.');
  }
  if (input.reportSince && !/^\d{4}-\d{2}-\d{2}$/.test(input.reportSince)) {
    throw new ExpenseReportError('The report-since date must be YYYY-MM-DD.');
  }

  const data = {
    ...(input.reimbursableAccountGuid !== undefined ? { reimbursable_account_guid: input.reimbursableAccountGuid } : {}),
    ...(input.employeeGuid !== undefined ? { employee_guid: input.employeeGuid } : {}),
    ...(input.settlementMode !== undefined ? { settlement_mode: input.settlementMode } : {}),
    ...(input.contributionAccountGuid !== undefined ? { contribution_account_guid: input.contributionAccountGuid } : {}),
    ...(input.householdInvestmentAccountGuid !== undefined
      ? { household_investment_account_guid: input.householdInvestmentAccountGuid }
      : {}),
    ...(input.householdDepositAccountGuid !== undefined
      ? { household_deposit_account_guid: input.householdDepositAccountGuid }
      : {}),
    ...(input.paymentAccountGuid !== undefined ? { payment_account_guid: input.paymentAccountGuid } : {}),
    ...(input.submissionDeadlineDays !== undefined ? { submission_deadline_days: input.submissionDeadlineDays } : {}),
    ...(input.reportSince !== undefined
      ? { report_since: input.reportSince ? new Date(`${input.reportSince}T00:00:00Z`) : null }
      : {}),
  };
  await prisma.gnucash_web_expense_report_settings.upsert({
    where: {
      business_book_guid_household_book_guid: {
        business_book_guid: businessBookGuid,
        household_book_guid: householdBookGuid,
      },
    },
    create: { business_book_guid: businessBookGuid, household_book_guid: householdBookGuid, ...data },
    update: { ...data, updated_at: new Date() },
  });
  return getSettings(businessBookGuid, householdBookGuid);
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export interface ReportLine {
  id: number;
  kind: 'business' | 'personal';
  sourceSplitGuid: string;
  sourceTxGuid: string;
  amountCents: number;
  expenseDate: string;
  description: string;
  businessPurpose: string | null;
  expenseAccountGuid: string | null;
  categorizedBy: string | null;
  documentIds: number[];
  accountablePlan: boolean;
  late: boolean;
  sortOrder: number;
}

export interface ReportRecord {
  id: number;
  number: number;
  label: string;
  businessBookGuid: string;
  householdBookGuid: string;
  status: ReportStatus;
  settlementMode: SettlementMode;
  title: string | null;
  notes: string | null;
  submittedBy: number | null;
  submittedAt: string;
  approvedAt: string | null;
  voucherGuid: string | null;
  businessTxnGuid: string | null;
  paymentTxnGuid: string | null;
  paidAt: string | null;
  householdTxnGuid: string | null;
  householdSettledAt: string | null;
  rejectionReason: string | null;
  totalCents: number;
  lines: ReportLine[];
}

type ReportRow = Awaited<ReturnType<typeof prisma.gnucash_web_expense_reports.findFirst>> & {
  lines: Array<Awaited<ReturnType<typeof prisma.gnucash_web_expense_report_lines.findFirst>>>;
};

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function mapLine(l: NonNullable<ReportRow['lines'][number]>): ReportLine {
  return {
    id: l.id,
    kind: l.kind === 'personal' ? 'personal' : 'business',
    sourceSplitGuid: l.source_split_guid,
    sourceTxGuid: l.source_tx_guid,
    amountCents: Math.round(Number(l.amount) * 100),
    expenseDate: l.expense_date.toISOString().slice(0, 10),
    description: l.description ?? '',
    businessPurpose: l.business_purpose,
    expenseAccountGuid: l.expense_account_guid,
    categorizedBy: l.categorized_by,
    documentIds: l.document_ids ?? [],
    accountablePlan: l.accountable_plan,
    late: l.late,
    sortOrder: l.sort_order,
  };
}

export function mapReport(r: NonNullable<ReportRow>): ReportRecord {
  const lines = (r.lines ?? [])
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map(mapLine)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return {
    id: r.id,
    number: r.number,
    label: formatReportNumber(r.number),
    businessBookGuid: r.business_book_guid,
    householdBookGuid: r.household_book_guid,
    status: r.status as ReportStatus,
    settlementMode: r.settlement_mode === 'contribution' ? 'contribution' : 'reimburse',
    title: r.title,
    notes: r.notes,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at.toISOString(),
    approvedAt: iso(r.approved_at),
    voucherGuid: r.voucher_guid,
    businessTxnGuid: r.business_txn_guid,
    paymentTxnGuid: r.payment_txn_guid,
    paidAt: iso(r.paid_at),
    householdTxnGuid: r.household_txn_guid,
    householdSettledAt: iso(r.household_settled_at),
    rejectionReason: r.rejection_reason,
    totalCents: lines.reduce((s, l) => s + l.amountCents, 0),
    lines,
  };
}

/** Load a report the caller may see from `bookGuid` (either side of the link). */
export async function loadReport(reportId: number, bookGuid: string): Promise<ReportRecord> {
  const row = await prisma.gnucash_web_expense_reports.findFirst({
    where: { id: reportId, OR: [{ business_book_guid: bookGuid }, { household_book_guid: bookGuid }] },
    include: { lines: true },
  });
  if (!row) throw new ExpenseReportError('Expense report not found.', 404);
  return mapReport(row as NonNullable<ReportRow>);
}

/** Serialize work on one report (and everything it touches) across requests. */
export function withReportLock<T>(reportId: number, fn: () => Promise<T>): Promise<T> {
  return withDatabaseAdvisoryLock(`expense_report:${reportId}`, fn);
}

/**
 * Serialize allocation changes for one household book. The invariant (live
 * report lines never claim more than a charge is worth) spans many splits and
 * is checked with plain reads, so every writer of allocations for the book
 * takes this one lock — a lock per split would hold one pool connection each.
 */
export function withAllocationLock<T>(householdBookGuid: string, fn: () => Promise<T>): Promise<T> {
  return withDatabaseAdvisoryLock(`expense_alloc:${householdBookGuid}`, fn);
}
