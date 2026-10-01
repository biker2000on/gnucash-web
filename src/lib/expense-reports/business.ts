/**
 * Owner expense reports — business side: categorize, approve (post a
 * voucher, or record a capital contribution), recategorize a posted report,
 * pay the owner, and record the household side of the settlement.
 */

import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { afterLedgerWrite } from '@/lib/data-events';
import { logAudit, snapshotTransactionByGuid } from '@/lib/services/audit.service';
import { assertNotLocked } from '@/lib/services/period-lock.service';
import { createRule } from '@/lib/services/categorization.service';
import {
  createVoucher,
  deleteVoucher,
  getVoucher,
  payVouchers,
  postVoucher,
  unpostVoucher,
  updateVoucher,
} from '@/lib/business/vouchers';
import { InvoiceStateError, InvoiceValidationError } from '@/lib/business/invoice-engine';
import { getEntityStatusAt } from '@/lib/services/entity-status.service';
import {
  approvalBlockers,
  contributionSplits,
  householdSettlementSplits,
  requiresAccountablePlan,
  summarizeByAccount,
  type CategorizedLine,
} from './model';
import {
  ExpenseReportError,
  getSettings,
  loadReport,
  requireBookEdit,
  withReportLock,
  type ExpenseReportContext,
  type ReportRecord,
} from './shared';
import {
  LedgerValidationError,
  accountCurrency,
  assertPostableAccounts,
  createTransaction,
  loadSplits,
  rewriteSplit,
} from './ledger';
import { linkDocumentsToTransaction } from './documents';
import { payeePattern } from './suggestions';

function rethrow(error: unknown): never {
  if (error instanceof LedgerValidationError || error instanceof InvoiceValidationError) {
    throw new ExpenseReportError(error.message);
  }
  if (error instanceof InvoiceStateError) throw new ExpenseReportError(error.message, 409);
  throw error;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function businessReport(ctx: ExpenseReportContext, businessBookGuid: string, reportId: number): Promise<ReportRecord> {
  const report = await loadReport(reportId, businessBookGuid);
  if (report.businessBookGuid !== businessBookGuid) throw new ExpenseReportError('Expense report not found.', 404);
  await requireBookEdit(ctx, businessBookGuid, 'business');
  return report;
}

async function assertExpenseAccount(businessBookGuid: string, accountGuid: string): Promise<void> {
  const inBook = new Set(await getAccountGuidsForBook(businessBookGuid));
  const account = await prisma.accounts.findUnique({
    where: { guid: accountGuid },
    select: { account_type: true, placeholder: true, name: true },
  });
  if (!account || !inBook.has(accountGuid)) throw new ExpenseReportError('That account is not in the business book.');
  if (account.placeholder) throw new ExpenseReportError(`${account.name} is a placeholder account.`);
  if (!['EXPENSE', 'ASSET'].includes(account.account_type)) {
    throw new ExpenseReportError('Categorize to an expense account (or an asset account for equipment).');
  }
}

/* ------------------------------------------------------------------ */
/* Categorize                                                          */
/* ------------------------------------------------------------------ */

export interface LineUpdate {
  lineId: number;
  /** Null clears back to uncategorized. Undefined leaves it unchanged. */
  expenseAccountGuid?: string | null;
  businessPurpose?: string | null;
  /** The line's name (what the voucher entry is called). Undefined leaves it. */
  description?: string;
}

function cleanDescription(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ExpenseReportError('A line needs a name.');
  if (trimmed.length > 500) throw new ExpenseReportError('Line names are limited to 500 characters.');
  return trimmed;
}

/**
 * Categorize lines of a report awaiting approval. A report that is already
 * posted goes through recategorizePostedReport (unpost → edit → repost).
 */
export async function updateReportLines(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  updates: readonly LineUpdate[],
  opts: { rememberLineIds?: readonly number[] } = {},
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'submitted') {
      throw new ExpenseReportError('Only a report awaiting approval can be categorized this way.', 409);
    }
    const lineIds = new Set(report.lines.map((l) => l.id));
    for (const u of updates) {
      if (!lineIds.has(u.lineId)) throw new ExpenseReportError('That line is not on this report.', 404);
      if (u.expenseAccountGuid) await assertExpenseAccount(businessBookGuid, u.expenseAccountGuid);
    }
    await prisma.$transaction(
      updates.map((u) =>
        prisma.gnucash_web_expense_report_lines.update({
          where: { id: u.lineId },
          data: {
            ...(u.expenseAccountGuid !== undefined
              ? { expense_account_guid: u.expenseAccountGuid, categorized_by: u.expenseAccountGuid ? 'manual' : null }
              : {}),
            ...(u.businessPurpose !== undefined ? { business_purpose: u.businessPurpose?.trim() || null } : {}),
            ...(u.description !== undefined ? { description: cleanDescription(u.description) } : {}),
          },
        }),
      ),
    );
    const updated = await loadReport(reportId, businessBookGuid);
    for (const lineId of opts.rememberLineIds ?? []) {
      await rememberPayee(ctx, businessBookGuid, updated, lineId);
    }
    return loadReport(reportId, businessBookGuid);
  });
}

/** "Remember for this payee": a contains-rule in the business book. */
async function rememberPayee(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  report: ReportRecord,
  lineId: number,
): Promise<void> {
  const line = report.lines.find((l) => l.id === lineId);
  if (!line) throw new ExpenseReportError('That line is not on this report.', 404);
  if (!line.expenseAccountGuid) throw new ExpenseReportError('Categorize the line before remembering its payee.');
  const pattern = payeePattern(line.description);
  if (!pattern) throw new ExpenseReportError('This payee has no usable text to match on.');
  const existing = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM gnucash_web_categorization_rules
     WHERE book_guid = ${businessBookGuid} AND pattern = ${pattern} AND match_type = 'contains'
  `.catch(() => [] as Array<{ id: number }>);
  if (existing.length > 0) {
    await prisma.$executeRaw`
      UPDATE gnucash_web_categorization_rules SET account_guid = ${line.expenseAccountGuid}
       WHERE id = ${existing[0].id}
    `;
  } else {
    await createRule(businessBookGuid, { pattern, matchType: 'contains', accountGuid: line.expenseAccountGuid });
  }
  void ctx;
}

/**
 * Split one line across several accounts (e.g. an Amazon order with a book
 * and TENS pads). The parts must add up to the line; together they still
 * claim the same share of the household charge.
 */
export async function splitReportLine(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  lineId: number,
  parts: ReadonlyArray<{ cents: number; expenseAccountGuid: string | null }>,
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'submitted') throw new ExpenseReportError('Only a report awaiting approval can be edited.', 409);
    const line = report.lines.find((l) => l.id === lineId);
    if (!line) throw new ExpenseReportError('That line is not on this report.', 404);
    if (parts.length < 2) throw new ExpenseReportError('Split a line into at least two parts.');
    if (parts.some((p) => !Number.isInteger(p.cents) || p.cents <= 0)) {
      throw new ExpenseReportError('Every part needs an amount greater than zero.');
    }
    if (parts.reduce((s, p) => s + p.cents, 0) !== line.amountCents) {
      throw new ExpenseReportError('The parts must add up to the line amount.');
    }
    for (const p of parts) if (p.expenseAccountGuid) await assertExpenseAccount(businessBookGuid, p.expenseAccountGuid);
    const row = await prisma.gnucash_web_expense_report_lines.findUniqueOrThrow({ where: { id: lineId } });
    await prisma.$transaction(async (tx) => {
      await tx.gnucash_web_expense_report_lines.update({
        where: { id: lineId },
        data: {
          amount: (parts[0].cents / 100).toFixed(2),
          expense_account_guid: parts[0].expenseAccountGuid,
          categorized_by: parts[0].expenseAccountGuid ? 'manual' : null,
        },
      });
      for (const p of parts.slice(1)) {
        await tx.gnucash_web_expense_report_lines.create({
          data: {
            report_id: row.report_id,
            kind: 'business',
            household_book_guid: row.household_book_guid,
            business_book_guid: row.business_book_guid,
            source_split_guid: row.source_split_guid,
            source_tx_guid: row.source_tx_guid,
            amount: (p.cents / 100).toFixed(2),
            expense_date: row.expense_date,
            description: row.description,
            business_purpose: row.business_purpose,
            expense_account_guid: p.expenseAccountGuid,
            categorized_by: p.expenseAccountGuid ? 'manual' : null,
            document_ids: row.document_ids,
            accountable_plan: row.accountable_plan,
            late: row.late,
            sort_order: row.sort_order,
            created_by: ctx.user.id,
          },
        });
      }
    });
    return loadReport(reportId, businessBookGuid);
  });
}

/* ------------------------------------------------------------------ */
/* Approve                                                             */
/* ------------------------------------------------------------------ */

export interface ApprovalPreview {
  mode: 'reimburse' | 'contribution';
  totalCents: number;
  byAccount: Array<{ accountGuid: string; cents: number; lines: number }>;
  blockers: string[];
  /** Account credited: the owner's A/P (reimburse) or the contribution equity account. */
  creditAccountGuid: string | null;
  postDate: string;
}

async function lineEvidence(report: ReportRecord): Promise<Map<number, { accountablePlan: boolean; missing: boolean }>> {
  const out = new Map<number, { accountablePlan: boolean; missing: boolean }>();
  for (const line of report.lines) {
    const status = await getEntityStatusAt(report.businessBookGuid, line.expenseDate);
    const required = requiresAccountablePlan(status.row.taxClassification);
    out.set(line.id, {
      accountablePlan: required,
      missing: required && (line.documentIds.length === 0 || !line.businessPurpose?.trim()),
    });
  }
  return out;
}

function categorized(report: ReportRecord): CategorizedLine[] {
  return report.lines.map((l) => ({
    amountCents: l.amountCents,
    expenseAccountGuid: l.expenseAccountGuid ?? '',
    description: l.businessPurpose ? `${l.description} — ${l.businessPurpose}` : l.description,
  }));
}

export async function previewApproval(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  postDate: string = todayIso(),
): Promise<ApprovalPreview> {
  const report = await businessReport(ctx, businessBookGuid, reportId);
  const settings = await getSettings(report.businessBookGuid, report.householdBookGuid);
  const evidence = await lineEvidence(report);
  const blockers = report.status === 'submitted' ? [] : ['This report is not awaiting approval.'];
  blockers.push(
    ...approvalBlockers(
      report.lines.map((l) => ({
        id: l.id,
        amountCents: l.amountCents,
        expenseAccountGuid: l.expenseAccountGuid,
        accountablePlan: evidence.get(l.id)!.accountablePlan,
        missingEvidence: evidence.get(l.id)!.missing,
      })),
      report.settlementMode,
    ),
  );
  if (report.settlementMode === 'reimburse' && !settings.employeeGuid) {
    blockers.push('Set up the owner’s employee record first.');
  }
  if (report.settlementMode === 'contribution') {
    if (!settings.contributionAccountGuid) blockers.push('Choose the business owner-contribution equity account.');
    if (!settings.householdInvestmentAccountGuid) blockers.push('Choose the household owner-investment account.');
  }
  return {
    mode: report.settlementMode,
    totalCents: report.totalCents,
    byAccount: summarizeByAccount(categorized(report).filter((l) => l.expenseAccountGuid)),
    blockers,
    creditAccountGuid: report.settlementMode === 'contribution' ? settings.contributionAccountGuid : null,
    postDate,
  };
}

/**
 * Approve a report. Reimburse mode: one voucher (one entry per line) posted
 * to A/P under the owner's employee record. Contribution mode: one business
 * transaction (debit expenses, credit owner contributions) and one household
 * transaction (debit owner investment, credit the receivable), written
 * atomically — needs edit on both books.
 */
export async function approveReport(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  opts: { postDate?: string; dueDate?: string } = {},
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const postDate = opts.postDate ?? todayIso();
    const preview = await previewApproval(ctx, businessBookGuid, reportId, postDate);
    if (preview.blockers.length > 0) throw new ExpenseReportError(preview.blockers.join(' '), 409);
    const report = await loadReport(reportId, businessBookGuid);
    const settings = await getSettings(report.businessBookGuid, report.householdBookGuid);
    const docIds = [...new Set(report.lines.flatMap((l) => l.documentIds))];

    if (report.settlementMode === 'contribution') {
      await requireBookEdit(ctx, report.householdBookGuid, 'household');
      return settleAsContribution(ctx, report, settings, postDate, docIds);
    }

    await assertNotLocked(businessBookGuid, [postDate]);
    let voucherGuid: string | null = null;
    try {
      const voucher = await createVoucher({
        bookGuid: businessBookGuid,
        employeeGuid: settings.employeeGuid!,
        id: report.label,
        billingId: report.label,
        dateOpened: postDate,
        notes: report.title ?? `Owner expense report ${report.label}`,
        entries: report.lines.map((l) => ({
          description: l.businessPurpose ? `${l.description} — ${l.businessPurpose}` : l.description,
          date: l.expenseDate,
          quantity: 1,
          price: l.amountCents / 100,
          accountGuid: l.expenseAccountGuid!,
        })),
      });
      voucherGuid = voucher.guid;
      const posted = await postVoucher(businessBookGuid, voucher.guid, {
        postDate,
        dueDate: opts.dueDate,
        memo: `Owner expense report ${report.label}`,
        description: `Expense report ${report.label}`,
      });
      await prisma.gnucash_web_expense_reports.update({
        where: { id: reportId },
        data: {
          status: 'posted',
          approved_by: ctx.user.id,
          approved_at: new Date(),
          voucher_guid: voucher.guid,
          business_txn_guid: posted.transactionGuid,
          updated_at: new Date(),
        },
      });
      await linkDocumentsToTransaction(businessBookGuid, docIds, posted.transactionGuid, ctx.user.id);
    } catch (error) {
      if (voucherGuid) {
        // Posting failed: drop the draft so a retry starts clean.
        await deleteVoucher(businessBookGuid, voucherGuid).catch(() => undefined);
      }
      rethrow(error);
    }
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'submitted' }, {
      status: 'posted',
      voucherGuid,
      totalCents: report.totalCents,
    }, { bookGuid: businessBookGuid, userId: ctx.user.id });
    return loadReport(reportId, businessBookGuid);
  });
}

async function settleAsContribution(
  ctx: ExpenseReportContext,
  report: ReportRecord,
  settings: Awaited<ReturnType<typeof getSettings>>,
  postDate: string,
  docIds: number[],
): Promise<ReportRecord> {
  const currency = await accountCurrency(settings.reimbursableAccountGuid!);
  if (!currency) throw new ExpenseReportError('The reimbursable account has no currency.');
  await assertNotLocked(report.businessBookGuid, [postDate]);
  await assertNotLocked(report.householdBookGuid, [postDate]);
  const { businessTxn, householdTxn } = await prisma
    .$transaction(async (tx) => {
      const businessTxn = await createTransaction(tx, {
        bookGuid: report.businessBookGuid,
        currencyGuid: currency,
        postDate,
        num: report.label,
        description: `Owner-paid expenses ${report.label} (capital contribution)`,
        splits: contributionSplits(categorized(report), settings.contributionAccountGuid!, report.label),
      });
      const householdTxn = await createTransaction(tx, {
        bookGuid: report.householdBookGuid,
        currencyGuid: currency,
        postDate,
        num: report.label,
        description: `Business expenses contributed to the business ${report.label}`,
        splits: householdSettlementSplits(
          settings.reimbursableAccountGuid!,
          settings.householdInvestmentAccountGuid!,
          report.totalCents,
          `Capital contribution ${report.label}`,
        ),
      });
      const updated = await tx.gnucash_web_expense_reports.updateMany({
        where: { id: report.id, status: 'submitted' },
        data: {
          status: 'settled',
          approved_by: ctx.user.id,
          approved_at: new Date(),
          business_txn_guid: businessTxn,
          household_txn_guid: householdTxn,
          household_settled_at: new Date(),
          updated_at: new Date(),
        },
      });
      if (updated.count !== 1) throw new ExpenseReportError('The report changed while it was being approved.', 409);
      return { businessTxn, householdTxn };
    })
    .catch(rethrow);
  for (const [book, txn] of [
    [report.businessBookGuid, businessTxn],
    [report.householdBookGuid, householdTxn],
  ] as const) {
    await logAudit('CREATE', 'TRANSACTION', txn, null, await snapshotTransactionByGuid(txn), { bookGuid: book, userId: ctx.user.id });
    afterLedgerWrite(book, 'transactions', { guid: txn, action: 'create', fromDate: new Date(`${postDate}T00:00:00Z`) });
  }
  await linkDocumentsToTransaction(report.businessBookGuid, docIds, businessTxn, ctx.user.id);
  await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${report.id}`, { status: 'submitted' }, {
    status: 'settled',
    mode: 'contribution',
    businessTxn,
    householdTxn,
  }, { bookGuid: report.businessBookGuid, userId: ctx.user.id });
  return loadReport(report.id, report.businessBookGuid);
}

/**
 * Recategorize lines of a POSTED (not yet paid) report: the voucher's splits
 * must match its entries, so this unposts (the engine writes a reversal),
 * edits the entries, and reposts on the original date. Refused once paid or
 * when that date is in a closed period.
 */
export async function recategorizePostedReport(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  updates: readonly LineUpdate[],
  opts: { dryRun?: boolean } = {},
): Promise<{ report: ReportRecord; byAccount: ApprovalPreview['byAccount'] }> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'posted' || !report.voucherGuid) {
      throw new ExpenseReportError(
        report.status === 'paid' || report.status === 'settled'
          ? 'This report has been paid; its categories can no longer change here.'
          : 'Only an approved, unpaid report can be recategorized.',
        409,
      );
    }
    const lineIds = new Set(report.lines.map((l) => l.id));
    for (const u of updates) {
      if (!lineIds.has(u.lineId)) throw new ExpenseReportError('That line is not on this report.', 404);
      // A posted voucher entry always has an account; it cannot go back to uncategorized.
      if (u.expenseAccountGuid === null) throw new ExpenseReportError('An approved line needs an expense account.');
      if (u.expenseAccountGuid) await assertExpenseAccount(businessBookGuid, u.expenseAccountGuid);
    }
    const updateOf = new Map(updates.map((u) => [u.lineId, u]));
    const nextLines = report.lines.map((l) => {
      const u = updateOf.get(l.id);
      if (!u) return l;
      return {
        ...l,
        expenseAccountGuid: u.expenseAccountGuid ?? l.expenseAccountGuid,
        description: u.description !== undefined ? cleanDescription(u.description) : l.description,
        businessPurpose: u.businessPurpose !== undefined ? u.businessPurpose?.trim() || null : l.businessPurpose,
      };
    });
    const byAccount = summarizeByAccount(categorized({ ...report, lines: nextLines }));
    if (opts.dryRun) return { report, byAccount };

    const voucher = await getVoucher(businessBookGuid, report.voucherGuid);
    const postDate = (voucher.datePosted ?? report.approvedAt ?? todayIso()).slice(0, 10);
    await assertNotLocked(businessBookGuid, [postDate]);
    try {
      await unpostVoucher(businessBookGuid, report.voucherGuid);
      await updateVoucher(businessBookGuid, report.voucherGuid, {
        entries: nextLines.map((l) => ({
          description: l.businessPurpose ? `${l.description} — ${l.businessPurpose}` : l.description,
          date: l.expenseDate,
          quantity: 1,
          price: l.amountCents / 100,
          accountGuid: l.expenseAccountGuid!,
        })),
      });
      const posted = await postVoucher(businessBookGuid, report.voucherGuid, {
        postDate,
        memo: `Owner expense report ${report.label}`,
        description: `Expense report ${report.label}`,
      });
      await prisma.$transaction([
        ...nextLines
          .filter((l) => updateOf.has(l.id))
          .map((l) =>
            prisma.gnucash_web_expense_report_lines.update({
              where: { id: l.id },
              data: {
                expense_account_guid: l.expenseAccountGuid,
                description: l.description,
                business_purpose: l.businessPurpose,
                ...(updateOf.get(l.id)!.expenseAccountGuid ? { categorized_by: 'manual' } : {}),
              },
            }),
          ),
        prisma.gnucash_web_expense_reports.update({
          where: { id: reportId },
          data: { business_txn_guid: posted.transactionGuid, updated_at: new Date() },
        }),
      ]);
      await linkDocumentsToTransaction(
        businessBookGuid,
        [...new Set(report.lines.flatMap((l) => l.documentIds))],
        posted.transactionGuid,
        ctx.user.id,
      );
    } catch (error) {
      rethrow(error);
    }
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, {
      lines: report.lines.map((l) => ({ id: l.id, account: l.expenseAccountGuid, description: l.description })),
    }, { lines: nextLines.map((l) => ({ id: l.id, account: l.expenseAccountGuid, description: l.description })), reposted: true }, {
      bookGuid: businessBookGuid,
      userId: ctx.user.id,
    });
    return { report: await loadReport(reportId, businessBookGuid), byAccount };
  });
}

/**
 * Settle an APPROVED (posted, unpaid) report as a capital contribution
 * instead of paying cash: the voucher is paid from the business's owner-
 * contribution equity account (debit A/P due to owner, credit Owner's
 * Contributions — the engine closes the voucher's lot as for any payment),
 * and the household receivable is reclassed to the owner's investment in
 * the business. No cash moves. Needs edit on both books.
 *
 * Refused for lines dated while the business is taxed as a corporation:
 * those must be reimbursed under the accountable plan to stay deductible.
 */
export async function settlePostedAsContribution(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  input: { contributionAccountGuid: string; householdInvestmentAccountGuid: string; date?: string },
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'posted' || !report.voucherGuid) {
      throw new ExpenseReportError('Only an approved, unpaid report can be settled as a contribution.', 409);
    }
    await requireBookEdit(ctx, report.householdBookGuid, 'household');
    const evidence = await lineEvidence(report);
    if (report.lines.some((l) => evidence.get(l.id)?.accountablePlan)) {
      throw new ExpenseReportError(
        'Some lines are dated while the business is taxed as a corporation. Those must be reimbursed under the accountable plan; settling them as a capital contribution would forfeit the deduction.',
        409,
      );
    }
    const settings = await getSettings(report.businessBookGuid, report.householdBookGuid);
    const receivable = settings.reimbursableAccountGuid;
    if (!receivable) throw new ExpenseReportError('The reimbursable account is not set.');

    // Validate both sides BEFORE paying, so a household-side problem cannot
    // leave the business paid and the household uncleared.
    const contribution = await prisma.accounts.findUnique({
      where: { guid: input.contributionAccountGuid },
      select: { account_type: true },
    });
    if (!contribution || contribution.account_type !== 'EQUITY') {
      throw new ExpenseReportError('Choose the business owner-contribution equity account.');
    }
    const investment = await prisma.accounts.findUnique({
      where: { guid: input.householdInvestmentAccountGuid },
      select: { account_type: true },
    });
    if (!investment || !['EQUITY', 'ASSET'].includes(investment.account_type)) {
      throw new ExpenseReportError('Choose the household owner-investment account (equity or asset).');
    }
    const currency = await accountCurrency(receivable);
    if (!currency) throw new ExpenseReportError('The reimbursable account has no currency.');
    await assertPostableAccounts(report.businessBookGuid, [input.contributionAccountGuid], currency).catch(rethrow);
    await assertPostableAccounts(report.householdBookGuid, [input.householdInvestmentAccountGuid, receivable], currency).catch(rethrow);
    const date = input.date ?? todayIso();
    await assertNotLocked(report.businessBookGuid, [date]);
    await assertNotLocked(report.householdBookGuid, [date]);

    let paymentTxn: string;
    try {
      const payment = await payVouchers(businessBookGuid, {
        employeeGuid: settings.employeeGuid!,
        transferAccountGuid: input.contributionAccountGuid,
        amount: report.totalCents / 100,
        date,
        num: report.label,
        memo: `Capital contribution ${report.label}`,
        allocations: [{ invoiceGuid: report.voucherGuid, amount: report.totalCents / 100 }],
      });
      paymentTxn = payment.transactionGuid;
    } catch (error) {
      rethrow(error);
    }
    // The business side is committed; record it before the household write so
    // a failure there leaves an honest 'paid' report the owner can finish.
    await prisma.gnucash_web_expense_reports.update({
      where: { id: reportId },
      data: {
        status: 'paid',
        settlement_mode: 'contribution',
        payment_txn_guid: paymentTxn,
        paid_at: new Date(`${date}T12:00:00Z`),
        updated_at: new Date(),
      },
    });

    const householdTxn = await prisma
      .$transaction(async (tx) => {
        const guid = await createTransaction(tx, {
          bookGuid: report.householdBookGuid,
          currencyGuid: currency,
          postDate: date,
          num: report.label,
          description: `Business expenses contributed to the business ${report.label}`,
          splits: householdSettlementSplits(
            receivable,
            input.householdInvestmentAccountGuid,
            report.totalCents,
            `Capital contribution ${report.label}`,
          ),
        });
        await markSettled(tx, report.id, guid);
        return guid;
      })
      .catch(rethrow);

    for (const [book, txn] of [
      [report.businessBookGuid, paymentTxn],
      [report.householdBookGuid, householdTxn],
    ] as const) {
      await logAudit('CREATE', 'TRANSACTION', txn, null, await snapshotTransactionByGuid(txn), { bookGuid: book, userId: ctx.user.id });
      afterLedgerWrite(book, 'transactions', { guid: txn, action: 'create', fromDate: new Date(`${date}T00:00:00Z`) });
    }
    if (!settings.contributionAccountGuid || !settings.householdInvestmentAccountGuid) {
      await prisma.gnucash_web_expense_report_settings
        .update({
          where: {
            business_book_guid_household_book_guid: {
              business_book_guid: report.businessBookGuid,
              household_book_guid: report.householdBookGuid,
            },
          },
          data: {
            contribution_account_guid: settings.contributionAccountGuid ?? input.contributionAccountGuid,
            household_investment_account_guid: settings.householdInvestmentAccountGuid ?? input.householdInvestmentAccountGuid,
          },
        })
        .catch(() => undefined);
    }
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'posted' }, {
      status: 'settled',
      mode: 'contribution',
      paymentTxn,
      householdTxn,
    }, { bookGuid: businessBookGuid, userId: ctx.user.id });
    return loadReport(reportId, businessBookGuid);
  });
}

export async function rejectReport(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  reason: string,
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'submitted') throw new ExpenseReportError('Only a report awaiting approval can be rejected.', 409);
    if (!reason.trim()) throw new ExpenseReportError('Give a reason so the owner knows what to fix.');
    await prisma.gnucash_web_expense_reports.update({
      where: { id: reportId },
      data: { status: 'rejected', rejection_reason: reason.trim(), approved_by: ctx.user.id, updated_at: new Date() },
    });
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'submitted' }, { status: 'rejected', reason }, {
      bookGuid: businessBookGuid,
      userId: ctx.user.id,
    });
    return loadReport(reportId, businessBookGuid);
  });
}

/* ------------------------------------------------------------------ */
/* Pay + household settlement                                          */
/* ------------------------------------------------------------------ */

export interface DepositMatch {
  txGuid: string;
  date: string;
  description: string;
  /** The deposit's counter split that would be recoded to the receivable. */
  counterSplitGuid: string;
  counterAccountName: string;
}

/**
 * SimpleFIN-imported deposits in the household deposit account that look
 * like this reimbursement: same amount, within `windowDays` of `date`, two
 * splits, and not already booked against the receivable.
 */
export async function findDepositMatches(
  report: ReportRecord,
  depositAccountGuid: string,
  receivableAccountGuid: string,
  date: string,
  windowDays = 7,
): Promise<DepositMatch[]> {
  const center = new Date(`${date}T12:00:00Z`);
  const from = new Date(center.getTime() - windowDays * 86_400_000);
  const to = new Date(center.getTime() + windowDays * 86_400_000);
  const cents = report.totalCents;
  const rows = await prisma.$queryRaw<Array<{ tx_guid: string; post_date: Date; description: string | null; counter_guid: string; counter_account: string; counter_account_guid: string }>>`
    SELECT t.guid AS tx_guid, t.post_date, t.description,
           c.guid AS counter_guid, a.name AS counter_account, c.account_guid AS counter_account_guid
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
      JOIN gnucash_web_transaction_meta m ON m.transaction_guid = t.guid AND m.source = 'simplefin'
      JOIN splits c ON c.tx_guid = t.guid AND c.guid <> s.guid
      JOIN accounts a ON a.guid = c.account_guid
     WHERE s.account_guid = ${depositAccountGuid}
       AND s.value_num * 100 = ${cents} * s.value_denom
       AND t.post_date BETWEEN ${from} AND ${to}
       AND (SELECT COUNT(*) FROM splits x WHERE x.tx_guid = t.guid) = 2
       AND c.account_guid <> ${receivableAccountGuid}
       AND c.reconcile_state <> 'y'
     ORDER BY ABS(EXTRACT(EPOCH FROM (t.post_date - ${center}::timestamptz)))
     LIMIT 5
  `;
  const bookAccounts = new Set(await getAccountGuidsForBook(report.householdBookGuid));
  return rows
    .filter((r) => bookAccounts.has(r.counter_account_guid))
    .map((r) => ({
      txGuid: r.tx_guid,
      date: r.post_date.toISOString().slice(0, 10),
      description: r.description ?? '',
      counterSplitGuid: r.counter_guid,
      counterAccountName: r.counter_account,
    }));
}

/** Pay the owner for a posted report from a business bank/card account. */
export async function payReport(
  ctx: ExpenseReportContext,
  businessBookGuid: string,
  reportId: number,
  input: { paymentAccountGuid: string; date?: string; num?: string },
): Promise<ReportRecord> {
  return withReportLock(reportId, async () => {
    const report = await businessReport(ctx, businessBookGuid, reportId);
    if (report.status !== 'posted' || !report.voucherGuid) {
      throw new ExpenseReportError('Only an approved, unpaid report can be paid.', 409);
    }
    const settings = await getSettings(report.businessBookGuid, report.householdBookGuid);
    const date = input.date ?? todayIso();
    await assertNotLocked(businessBookGuid, [date]);
    let paymentTxn: string;
    try {
      const payment = await payVouchers(businessBookGuid, {
        employeeGuid: settings.employeeGuid!,
        transferAccountGuid: input.paymentAccountGuid,
        amount: report.totalCents / 100,
        date,
        num: input.num ?? report.label,
        memo: `Reimbursement ${report.label}`,
        allocations: [{ invoiceGuid: report.voucherGuid, amount: report.totalCents / 100 }],
      });
      paymentTxn = payment.transactionGuid;
    } catch (error) {
      rethrow(error);
    }
    await prisma.gnucash_web_expense_reports.update({
      where: { id: reportId },
      data: { status: 'paid', payment_txn_guid: paymentTxn, paid_at: new Date(`${date}T12:00:00Z`), updated_at: new Date() },
    });
    if (!settings.paymentAccountGuid) {
      await prisma.gnucash_web_expense_report_settings.update({
        where: {
          business_book_guid_household_book_guid: {
            business_book_guid: report.businessBookGuid,
            household_book_guid: report.householdBookGuid,
          },
        },
        data: { payment_account_guid: input.paymentAccountGuid },
      }).catch(() => undefined);
    }
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'posted' }, {
      status: 'paid',
      paymentTxn,
    }, { bookGuid: businessBookGuid, userId: ctx.user.id });
    return loadReport(reportId, businessBookGuid);
  });
}

/**
 * Record the household side of a paid reimbursement: either recode a
 * matched SimpleFIN deposit's counter split onto the receivable, or create
 * a deposit transaction (debit the deposit account, credit the receivable).
 * Records the business payment and the household deposit as an approved
 * interbook elimination so consolidated views do not count it twice.
 */
export async function settleHousehold(
  ctx: ExpenseReportContext,
  bookGuid: string,
  reportId: number,
  input: { depositAccountGuid: string; date?: string; matchTxGuid?: string | null; dryRun?: boolean },
): Promise<{ report: ReportRecord; matches: DepositMatch[]; action: 'matched' | 'created' | 'preview' }> {
  return withReportLock(reportId, async () => {
    const report = await loadReport(reportId, bookGuid);
    await requireBookEdit(ctx, report.householdBookGuid, 'household');
    if (report.status !== 'paid') throw new ExpenseReportError('Only a paid report can be settled on the household side.', 409);
    const settings = await getSettings(report.businessBookGuid, report.householdBookGuid);
    const receivable = settings.reimbursableAccountGuid!;
    const date = input.date ?? report.paidAt?.slice(0, 10) ?? todayIso();
    // A contribution settled on the business side (but not yet on the
    // household side) reclasses the receivable to the owner's investment —
    // no cash arrived, so there is no deposit to match or eliminate.
    const contribution = report.settlementMode === 'contribution';
    if (contribution && !settings.householdInvestmentAccountGuid) {
      throw new ExpenseReportError('Choose the household owner-investment account in Setup first.');
    }
    const counterAccount = contribution ? settings.householdInvestmentAccountGuid! : input.depositAccountGuid;
    const matches = contribution ? [] : await findDepositMatches(report, input.depositAccountGuid, receivable, date);
    if (input.dryRun) return { report, matches, action: 'preview' };

    const currency = await accountCurrency(receivable);
    if (!currency) throw new ExpenseReportError('The reimbursable account has no currency.');
    let householdTxn: string;
    let action: 'matched' | 'created';
    if (input.matchTxGuid) {
      const match = matches.find((m) => m.txGuid === input.matchTxGuid);
      if (!match) throw new ExpenseReportError('That deposit no longer matches this reimbursement.', 409);
      const counter = (await loadSplits(report.householdBookGuid, [match.counterSplitGuid])).get(match.counterSplitGuid)!;
      await assertNotLocked(report.householdBookGuid, [counter.postDate]);
      const before = await snapshotTransactionByGuid(match.txGuid);
      await prisma
        .$transaction(async (tx) => {
          await rewriteSplit(tx, report.householdBookGuid, match.counterSplitGuid, [
            { accountGuid: receivable, cents: counter.valueCents, memo: `Reimbursement ${report.label}` },
          ]);
          await markSettled(tx, report.id, match.txGuid);
        })
        .catch(rethrow);
      await logAudit('UPDATE', 'TRANSACTION', match.txGuid, before as object, await snapshotTransactionByGuid(match.txGuid), {
        bookGuid: report.householdBookGuid,
        userId: ctx.user.id,
      });
      householdTxn = match.txGuid;
      action = 'matched';
    } else {
      await assertNotLocked(report.householdBookGuid, [date]);
      householdTxn = await prisma
        .$transaction(async (tx) => {
          const guid = await createTransaction(tx, {
            bookGuid: report.householdBookGuid,
            currencyGuid: currency,
            postDate: date,
            num: report.label,
            description: contribution
              ? `Business expenses contributed to the business ${report.label}`
              : `Reimbursement ${report.label}`,
            splits: householdSettlementSplits(
              receivable,
              counterAccount,
              report.totalCents,
              contribution ? `Capital contribution ${report.label}` : `Reimbursement ${report.label}`,
            ),
          });
          await markSettled(tx, report.id, guid);
          return guid;
        })
        .catch(rethrow);
      await logAudit('CREATE', 'TRANSACTION', householdTxn, null, await snapshotTransactionByGuid(householdTxn), {
        bookGuid: report.householdBookGuid,
        userId: ctx.user.id,
      });
      action = 'created';
    }
    afterLedgerWrite(report.householdBookGuid, 'transactions', { guid: householdTxn, fromDate: new Date(`${date}T00:00:00Z`) });

    // Interbook elimination: the business payment and the household deposit
    // are the same cash moving between the owner's books.
    if (report.paymentTxnGuid && !contribution) {
      const mnemonic = await prisma.commodities.findUnique({ where: { guid: currency }, select: { mnemonic: true } });
      await prisma.$executeRaw`
        INSERT INTO gnucash_web_interbook_eliminations
          (user_id, household_book_guid, left_book_guid, left_transaction_guid,
           right_book_guid, right_transaction_guid, amount, currency, status)
        VALUES (${ctx.user.id}, ${report.householdBookGuid}, ${report.businessBookGuid}, ${report.paymentTxnGuid},
                ${report.householdBookGuid}, ${householdTxn}, ${(report.totalCents / 100).toFixed(2)}::numeric,
                ${mnemonic?.mnemonic ?? 'USD'}, 'approved')
        ON CONFLICT (user_id, left_transaction_guid, right_transaction_guid) DO NOTHING
      `.catch((error) => console.warn('Interbook elimination insert failed:', error));
    }
    if (!settings.householdDepositAccountGuid && !contribution) {
      await prisma.gnucash_web_expense_report_settings.update({
        where: {
          business_book_guid_household_book_guid: {
            business_book_guid: report.businessBookGuid,
            household_book_guid: report.householdBookGuid,
          },
        },
        data: { household_deposit_account_guid: input.depositAccountGuid },
      }).catch(() => undefined);
    }
    await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'paid' }, {
      status: 'settled',
      householdTxn,
      action,
    }, { bookGuid: report.householdBookGuid, userId: ctx.user.id });
    return { report: await loadReport(reportId, bookGuid), matches, action };
  });
}

async function markSettled(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], reportId: number, householdTxn: string): Promise<void> {
  const updated = await tx.gnucash_web_expense_reports.updateMany({
    where: { id: reportId, status: 'paid' },
    data: { status: 'settled', household_txn_guid: householdTxn, household_settled_at: new Date(), updated_at: new Date() },
  });
  if (updated.count !== 1) throw new ExpenseReportError('The report changed while it was being settled.', 409);
}
