/**
 * Owner expense reports — household side: what can be reported, marking
 * charges (and personal portions), submitting a report, withdrawing it.
 */

import prisma from '@/lib/prisma';
import { afterLedgerWrite } from '@/lib/data-events';
import { logAudit, snapshotTransactionByGuid } from '@/lib/services/audit.service';
import { assertNotLocked } from '@/lib/services/period-lock.service';
import { getEntityStatusAt } from '@/lib/services/entity-status.service';
import { listEnabledRules, matchRule } from '@/lib/services/categorization.service';
import {
  ensureCanonicalDocumentPlatform,
} from '@/lib/documents/service';
import {
  allocationError,
  chooseSuggestion,
  describeSplitAllocation,
  evaluateAccountablePlan,
  remainderCents,
  type AllocationRow,
  type ReportStatus,
  type SplitAllocationView,
} from './model';
import {
  ExpenseReportError,
  assertBookLink,
  getSettings,
  loadReport,
  requireBookEdit,
  withAllocationLock,
  type ExpenseReportContext,
  type ReportRecord,
} from './shared';
import { LedgerValidationError, loadSplits, rewriteSplit } from './ledger';
import { copyDocumentsToBook } from './documents';
import { historySuggestions } from './suggestions';

/* ------------------------------------------------------------------ */
/* Allocation rows                                                     */
/* ------------------------------------------------------------------ */

interface AllocationDbRow {
  source_split_guid: string;
  kind: string;
  amount: string;
  report_number: number | null;
  report_status: string | null;
  paid_at: Date | null;
}

async function allocationRows(splitGuids: readonly string[]): Promise<Map<string, SplitAllocationView[]>> {
  const out = new Map<string, SplitAllocationView[]>();
  if (splitGuids.length === 0) return out;
  const rows = await prisma.$queryRaw<AllocationDbRow[]>`
    SELECT l.source_split_guid, l.kind, l.amount::text AS amount,
           r.number AS report_number, r.status AS report_status, r.paid_at
      FROM gnucash_web_expense_report_lines l
      LEFT JOIN gnucash_web_expense_reports r ON r.id = l.report_id
     WHERE l.source_split_guid = ANY(${[...splitGuids]}::text[])
  `;
  for (const r of rows) {
    const list = out.get(r.source_split_guid) ?? [];
    list.push({
      kind: r.kind === 'personal' ? 'personal' : 'business',
      amountCents: Math.round(Number(r.amount) * 100),
      reportNumber: r.report_number,
      reportStatus: (r.report_status as ReportStatus | null) ?? null,
      paidOn: r.paid_at ? r.paid_at.toISOString().slice(0, 10) : null,
    });
    out.set(r.source_split_guid, list);
  }
  return out;
}

function asAllocation(rows: readonly SplitAllocationView[]): AllocationRow[] {
  return rows.map((r) => ({ kind: r.kind, amountCents: r.amountCents, reportStatus: r.reportStatus }));
}

/** Ledger badge text per split guid (only splits with an allocation). */
export async function splitAllocationBadges(
  householdBookGuid: string,
  splitGuids: readonly string[],
): Promise<Record<string, string>> {
  if (splitGuids.length === 0) return {};
  const [splits, rows] = await Promise.all([
    loadSplits(householdBookGuid, splitGuids).catch(() => new Map()),
    allocationRows(splitGuids),
  ]);
  const out: Record<string, string> = {};
  for (const [guid, list] of rows) {
    const split = splits.get(guid);
    if (!split) continue;
    const text = describeSplitAllocation(split.valueCents, list);
    if (text) out[guid] = text;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

export interface Candidate {
  splitGuid: string;
  txGuid: string;
  date: string;
  description: string;
  memo: string;
  /** Where the money came from (the card or bank split). */
  paidFrom: string | null;
  valueCents: number;
  remainderCents: number;
  documentCount: number;
  badge: string | null;
  reconciled: boolean;
}

interface CandidateDbRow {
  guid: string;
  tx_guid: string;
  memo: string | null;
  value_num: bigint;
  value_denom: bigint;
  reconcile_state: string;
  post_date: Date;
  description: string | null;
  paid_from: string | null;
}

async function documentCounts(bookGuid: string, txGuids: readonly string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (txGuids.length === 0) return out;
  await ensureCanonicalDocumentPlatform();
  const rows = await prisma.$queryRaw<Array<{ target_id: string; document_id: number }>>`
    SELECT target_id, document_id
      FROM gnucash_web_document_links
     WHERE book_guid = ${bookGuid} AND target_type = 'transaction'
       AND target_id = ANY(${[...txGuids]}::text[])
  `;
  for (const r of rows) {
    const list = out.get(r.target_id) ?? [];
    if (!list.includes(r.document_id)) list.push(r.document_id);
    out.set(r.target_id, list);
  }
  return out;
}

/**
 * Charges on the configured reimbursable account with something left to
 * report (or everything, with `includeAllocated`), newest first.
 */
export async function listCandidates(
  householdBookGuid: string,
  businessBookGuid: string,
  opts: { includeAllocated?: boolean } = {},
): Promise<{ candidates: Candidate[]; unreportedCents: number; configured: boolean }> {
  await assertBookLink(businessBookGuid, householdBookGuid);
  const settings = await getSettings(businessBookGuid, householdBookGuid);
  if (!settings.reimbursableAccountGuid) return { candidates: [], unreportedCents: 0, configured: false };
  const rows = await prisma.$queryRaw<CandidateDbRow[]>`
    SELECT s.guid, s.tx_guid, s.memo, s.value_num, s.value_denom, s.reconcile_state,
           t.post_date, t.description,
           (SELECT string_agg(a2.name, ', ' ORDER BY a2.name)
              FROM splits s2 JOIN accounts a2 ON a2.guid = s2.account_guid
             WHERE s2.tx_guid = s.tx_guid AND s2.guid <> s.guid AND s2.value_num < 0) AS paid_from
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
     WHERE s.account_guid = ${settings.reimbursableAccountGuid}
       AND s.value_num > 0
       AND t.post_date >= ${sinceDate(settings.reportSince)}
     ORDER BY t.post_date DESC, s.guid
  `;
  const splitGuids = rows.map((r) => r.guid);
  const [alloc, docs] = await Promise.all([
    allocationRows(splitGuids),
    documentCounts(householdBookGuid, [...new Set(rows.map((r) => r.tx_guid))]),
  ]);
  const candidates: Candidate[] = [];
  let unreported = 0;
  for (const r of rows) {
    const valueCents = Math.round((Number(r.value_num) * 100) / Number(r.value_denom));
    const list = alloc.get(r.guid) ?? [];
    const remaining = remainderCents(valueCents, asAllocation(list));
    unreported += remaining;
    if (remaining === 0 && !opts.includeAllocated) continue;
    candidates.push({
      splitGuid: r.guid,
      txGuid: r.tx_guid,
      date: r.post_date.toISOString().slice(0, 10),
      description: r.description ?? '',
      memo: r.memo ?? '',
      paidFrom: r.paid_from,
      valueCents,
      remainderCents: remaining,
      documentCount: docs.get(r.tx_guid)?.length ?? 0,
      badge: describeSplitAllocation(valueCents, list),
      reconciled: r.reconcile_state === 'y',
    });
  }
  return { candidates, unreportedCents: unreported, configured: true };
}

/** Lower bound for charges considered (the configured cutoff, else the epoch). */
export function sinceDate(reportSince: string | null): Date {
  return new Date(`${reportSince ?? '1900-01-01'}T00:00:00Z`);
}

/** Recent expense charges that could be moved onto the receivable. */
export async function listMarkable(
  householdBookGuid: string,
  businessBookGuid: string,
  opts: { days?: number; search?: string } = {},
): Promise<Array<{ splitGuid: string; txGuid: string; date: string; description: string; accountName: string; valueCents: number }>> {
  await assertBookLink(businessBookGuid, householdBookGuid);
  const days = Math.min(Math.max(opts.days ?? 120, 1), 730);
  const since = new Date(Date.now() - days * 86_400_000);
  const search = opts.search?.trim() ? `%${opts.search.trim()}%` : '%';
  const bookAccounts = await (await import('@/lib/book-scope')).getAccountGuidsForBook(householdBookGuid);
  const rows = await prisma.$queryRaw<Array<{ guid: string; tx_guid: string; post_date: Date; description: string | null; name: string; value_num: bigint; value_denom: bigint }>>`
    SELECT s.guid, s.tx_guid, t.post_date, t.description, a.name, s.value_num, s.value_denom
      FROM splits s
      JOIN transactions t ON t.guid = s.tx_guid
      JOIN accounts a ON a.guid = s.account_guid
     WHERE a.account_type = 'EXPENSE'
       AND s.account_guid = ANY(${bookAccounts}::text[])
       AND s.value_num > 0
       AND s.reconcile_state <> 'y'
       AND s.lot_guid IS NULL
       AND t.post_date >= ${since}
       AND t.description ILIKE ${search}
     ORDER BY t.post_date DESC
     LIMIT 200
  `;
  return rows.map((r) => ({
    splitGuid: r.guid,
    txGuid: r.tx_guid,
    date: r.post_date.toISOString().slice(0, 10),
    description: r.description ?? '',
    accountName: r.name,
    valueCents: Math.round((Number(r.value_num) * 100) / Number(r.value_denom)),
  }));
}

/* ------------------------------------------------------------------ */
/* Ledger rewrites (previewable)                                       */
/* ------------------------------------------------------------------ */

export interface RewritePreview {
  txGuid: string;
  date: string;
  description: string;
  before: Array<{ accountGuid: string; cents: number }>;
  after: Array<{ accountGuid: string; cents: number }>;
}

async function transactionSplits(txGuid: string): Promise<Array<{ guid: string; accountGuid: string; cents: number }>> {
  const rows = await prisma.splits.findMany({
    where: { tx_guid: txGuid },
    select: { guid: true, account_guid: true, value_num: true, value_denom: true },
  });
  return rows.map((r) => ({
    guid: r.guid,
    accountGuid: r.account_guid,
    cents: Math.round((Number(r.value_num) * 100) / Number(r.value_denom)),
  }));
}

async function finishHouseholdRewrite(
  householdBookGuid: string,
  ctx: ExpenseReportContext,
  txGuid: string,
  before: unknown,
  date: string,
): Promise<void> {
  await logAudit('UPDATE', 'TRANSACTION', txGuid, before as object, await snapshotTransactionByGuid(txGuid), {
    bookGuid: householdBookGuid,
    userId: ctx.user.id,
  });
  afterLedgerWrite(householdBookGuid, 'transactions', { guid: txGuid, action: 'update', fromDate: new Date(`${date}T00:00:00Z`) });
}

/**
 * Move part (or all) of an expense split onto the reimbursable receivable:
 * "Mark for reimbursement". One household transaction is rewritten; nothing
 * is written to the business book.
 */
export async function markForReimbursement(
  ctx: ExpenseReportContext,
  input: { householdBookGuid: string; businessBookGuid: string; splitGuid: string; cents?: number; dryRun?: boolean },
): Promise<RewritePreview> {
  await assertBookLink(input.businessBookGuid, input.householdBookGuid);
  await requireBookEdit(ctx, input.householdBookGuid, 'household');
  const settings = await getSettings(input.businessBookGuid, input.householdBookGuid);
  if (!settings.reimbursableAccountGuid) throw new ExpenseReportError('Choose the reimbursable account first.');
  const split = (await loadSplits(input.householdBookGuid, [input.splitGuid]).catch((e) => {
    throw new ExpenseReportError(e instanceof Error ? e.message : 'Charge not found', 404);
  })).get(input.splitGuid)!;
  if (split.accountGuid === settings.reimbursableAccountGuid) {
    throw new ExpenseReportError('This charge is already on the reimbursable account.');
  }
  if (split.valueCents <= 0) throw new ExpenseReportError('Only expense charges (debits) can be marked.');
  const cents = input.cents ?? split.valueCents;
  if (!Number.isInteger(cents) || cents <= 0 || cents > split.valueCents) {
    throw new ExpenseReportError('The amount must be between $0.01 and the charge amount.');
  }
  const parts = [{ accountGuid: settings.reimbursableAccountGuid, cents }];
  if (cents < split.valueCents) parts.push({ accountGuid: split.accountGuid, cents: split.valueCents - cents });

  const beforeSplits = await transactionSplits(split.txGuid);
  const preview: RewritePreview = {
    txGuid: split.txGuid,
    date: split.postDate,
    description: split.description,
    before: beforeSplits.map(({ accountGuid, cents: c }) => ({ accountGuid, cents: c })),
    after: beforeSplits.flatMap((s) =>
      s.guid === split.guid ? parts.map((p) => ({ accountGuid: p.accountGuid, cents: p.cents })) : [{ accountGuid: s.accountGuid, cents: s.cents }],
    ),
  };
  if (input.dryRun) return preview;

  await assertNotLocked(input.householdBookGuid, [split.postDate]);
  const before = await snapshotTransactionByGuid(split.txGuid);
  await prisma.$transaction((tx) => rewriteSplit(tx, input.householdBookGuid, split.guid, parts)).catch(rethrowLedger);
  await finishHouseholdRewrite(input.householdBookGuid, ctx, split.txGuid, before, split.postDate);
  return preview;
}

function rethrowLedger(error: unknown): never {
  if (error instanceof LedgerValidationError) throw new ExpenseReportError(error.message);
  throw error;
}

/**
 * Mark part of a reported charge as personal: the receivable split shrinks
 * and a new split books that part to a household expense account. The
 * `personal` allocation row records it.
 */
export async function markPersonal(
  ctx: ExpenseReportContext,
  input: {
    householdBookGuid: string;
    businessBookGuid: string;
    splitGuid: string;
    cents: number;
    personalAccountGuid: string;
    dryRun?: boolean;
  },
): Promise<RewritePreview> {
  await assertBookLink(input.businessBookGuid, input.householdBookGuid);
  await requireBookEdit(ctx, input.householdBookGuid, 'household');
  const settings = await getSettings(input.businessBookGuid, input.householdBookGuid);
  return withAllocationLock(input.householdBookGuid, async () => {
    const split = (await loadSplits(input.householdBookGuid, [input.splitGuid]).catch((e) => {
      throw new ExpenseReportError(e instanceof Error ? e.message : 'Charge not found', 404);
    })).get(input.splitGuid)!;
    if (split.accountGuid !== settings.reimbursableAccountGuid) {
      throw new ExpenseReportError('Only charges on the reimbursable account can be split off as personal.');
    }
    const rows = asAllocation((await allocationRows([split.guid])).get(split.guid) ?? []);
    const error = allocationError(split.valueCents, rows, input.cents);
    if (error) throw new ExpenseReportError(error);
    const parts = [
      ...(split.valueCents - input.cents > 0
        ? [{ accountGuid: split.accountGuid, cents: split.valueCents - input.cents }]
        : []),
      { accountGuid: input.personalAccountGuid, cents: input.cents },
    ];
    const beforeSplits = await transactionSplits(split.txGuid);
    const preview: RewritePreview = {
      txGuid: split.txGuid,
      date: split.postDate,
      description: split.description,
      before: beforeSplits.map(({ accountGuid, cents }) => ({ accountGuid, cents })),
      after: beforeSplits.flatMap((s) =>
        s.guid === split.guid ? parts.map((p) => ({ accountGuid: p.accountGuid, cents: p.cents })) : [{ accountGuid: s.accountGuid, cents: s.cents }],
      ),
    };
    const account = await prisma.accounts.findUnique({
      where: { guid: input.personalAccountGuid },
      select: { account_type: true },
    });
    if (!account || account.account_type !== 'EXPENSE') {
      throw new ExpenseReportError('Choose a household expense account for the personal part.');
    }
    if (input.dryRun) return preview;

    await assertNotLocked(input.householdBookGuid, [split.postDate]);
    const before = await snapshotTransactionByGuid(split.txGuid);
    await prisma
      .$transaction(async (tx) => {
        const guids = await rewriteSplit(tx, input.householdBookGuid, split.guid, parts);
        // When the whole charge goes personal, the original split guid now
        // holds the personal part; otherwise the personal part is the new one.
        const personalGuid = guids[guids.length - 1];
        await tx.gnucash_web_expense_report_lines.create({
          data: {
            report_id: null,
            kind: 'personal',
            household_book_guid: input.householdBookGuid,
            business_book_guid: input.businessBookGuid,
            source_split_guid: split.guid,
            source_tx_guid: split.txGuid,
            amount: (input.cents / 100).toFixed(2),
            expense_date: new Date(`${split.postDate}T00:00:00Z`),
            description: split.description,
            personal_account_guid: input.personalAccountGuid,
            personal_split_guid: personalGuid,
            created_by: ctx.user.id,
          },
        });
      })
      .catch(rethrowLedger);
    await finishHouseholdRewrite(input.householdBookGuid, ctx, split.txGuid, before, split.postDate);
    return preview;
  });
}

/* ------------------------------------------------------------------ */
/* Submit / withdraw                                                   */
/* ------------------------------------------------------------------ */

export interface SubmitLineInput {
  splitGuid: string;
  cents: number;
  businessPurpose?: string | null;
}

export interface SubmitLinePreview {
  splitGuid: string;
  date: string;
  description: string;
  amountCents: number;
  taxClassification: string;
  accountablePlan: boolean;
  missing: string[];
  late: boolean;
  suggestion: { accountGuid: string; categorizedBy: string } | null;
  documentIds: number[];
}

export interface SubmitResult {
  dryRun: boolean;
  lines: SubmitLinePreview[];
  totalCents: number;
  report: ReportRecord | null;
}

/** Local YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function submitReport(
  ctx: ExpenseReportContext,
  input: {
    householdBookGuid: string;
    businessBookGuid: string;
    lines: SubmitLineInput[];
    title?: string | null;
    notes?: string | null;
    dryRun?: boolean;
  },
): Promise<SubmitResult> {
  await assertBookLink(input.businessBookGuid, input.householdBookGuid);
  await requireBookEdit(ctx, input.householdBookGuid, 'household');
  const settings = await getSettings(input.businessBookGuid, input.householdBookGuid);
  if (!settings.reimbursableAccountGuid) throw new ExpenseReportError('Choose the reimbursable account first.');
  if (settings.settlementMode === 'reimburse' && !settings.employeeGuid) {
    throw new ExpenseReportError('Set up the owner’s employee record in the business book first.');
  }
  if (input.lines.length === 0) throw new ExpenseReportError('Pick at least one charge.');
  if (input.lines.length > 500) throw new ExpenseReportError('A report can have at most 500 lines.');

  return withAllocationLock(input.householdBookGuid, async () => {
    const splits = await loadSplits(input.householdBookGuid, input.lines.map((l) => l.splitGuid)).catch((e) => {
      throw new ExpenseReportError(e instanceof Error ? e.message : 'Charge not found', 404);
    });
    const alloc = await allocationRows([...splits.keys()]);
    // Requested amounts per split, summed (a split may appear twice).
    const requested = new Map<string, number>();
    for (const line of input.lines) {
      const split = splits.get(line.splitGuid)!;
      if (split.accountGuid !== settings.reimbursableAccountGuid) {
        throw new ExpenseReportError(`"${split.description}" is not on the reimbursable account.`);
      }
      if (settings.reportSince && split.postDate < settings.reportSince) {
        throw new ExpenseReportError(`"${split.description}" is dated before ${settings.reportSince}, when reporting starts.`);
      }
      requested.set(line.splitGuid, (requested.get(line.splitGuid) ?? 0) + line.cents);
      if (!Number.isInteger(line.cents) || line.cents <= 0) {
        throw new ExpenseReportError('Every line needs an amount greater than zero.');
      }
    }
    for (const [guid, cents] of requested) {
      const split = splits.get(guid)!;
      const error = allocationError(split.valueCents, asAllocation(alloc.get(guid) ?? []), cents);
      if (error) throw new ExpenseReportError(`${split.description} (${split.postDate}): ${error}`, 409);
    }

    const docs = await documentCounts(input.householdBookGuid, [...new Set([...splits.values()].map((s) => s.txGuid))]);
    const rules = await listEnabledRules(input.businessBookGuid);
    const history = await historySuggestions(
      input.businessBookGuid,
      input.lines.map((l) => splits.get(l.splitGuid)!.description),
    );
    const submittedDate = today();
    const previews: SubmitLinePreview[] = [];
    for (const line of input.lines) {
      const split = splits.get(line.splitGuid)!;
      const status = await getEntityStatusAt(input.businessBookGuid, split.postDate);
      const documentIds = docs.get(split.txGuid) ?? [];
      const plan = evaluateAccountablePlan({
        taxClassification: status.row.taxClassification,
        expenseDate: split.postDate,
        submittedDate,
        hasReceipt: documentIds.length > 0,
        businessPurpose: line.businessPurpose,
        deadlineDays: settings.submissionDeadlineDays,
      });
      const rule = matchRule(rules, split.description);
      previews.push({
        splitGuid: split.guid,
        date: split.postDate,
        description: split.description,
        amountCents: line.cents,
        taxClassification: status.row.taxClassification,
        accountablePlan: plan.required,
        missing: plan.missing,
        late: plan.late,
        suggestion: chooseSuggestion({
          rule: rule ? { id: rule.id, accountGuid: rule.accountGuid } : null,
          history: history.get(split.description) ?? [],
        }),
        documentIds,
      });
    }
    const totalCents = previews.reduce((s, p) => s + p.amountCents, 0);
    const blocked = previews.filter((p) => p.missing.length > 0);
    if (input.dryRun) return { dryRun: true, lines: previews, totalCents, report: null };
    if (blocked.length > 0) {
      throw new ExpenseReportError(
        `${blocked.length} line${blocked.length === 1 ? '' : 's'} dated while the business is taxed as a corporation need${blocked.length === 1 ? 's' : ''} a receipt and a business purpose (accountable plan).`,
      );
    }

    const reportId = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`expense_report_number:${input.businessBookGuid}`}::text))::text AS locked`;
      const max = await tx.gnucash_web_expense_reports.aggregate({
        where: { business_book_guid: input.businessBookGuid },
        _max: { number: true },
      });
      const report = await tx.gnucash_web_expense_reports.create({
        data: {
          business_book_guid: input.businessBookGuid,
          household_book_guid: input.householdBookGuid,
          number: (max._max.number ?? 0) + 1,
          status: 'submitted',
          settlement_mode: settings.settlementMode,
          title: input.title?.trim() || null,
          notes: input.notes?.trim() || null,
          submitted_by: ctx.user.id,
        },
      });
      await tx.gnucash_web_expense_report_lines.createMany({
        data: previews.map((p, i) => ({
          report_id: report.id,
          kind: 'business',
          household_book_guid: input.householdBookGuid,
          business_book_guid: input.businessBookGuid,
          source_split_guid: p.splitGuid,
          source_tx_guid: splits.get(p.splitGuid)!.txGuid,
          amount: (p.amountCents / 100).toFixed(2),
          expense_date: new Date(`${p.date}T00:00:00Z`),
          description: p.description,
          business_purpose: input.lines[i].businessPurpose?.trim() || null,
          expense_account_guid: p.suggestion?.accountGuid ?? null,
          categorized_by: p.suggestion?.categorizedBy ?? null,
          accountable_plan: p.accountablePlan,
          late: p.late,
          sort_order: i,
          created_by: ctx.user.id,
        })),
      });
      return report.id;
    });

    // Receipts travel with the report: copy each source document into the
    // business book (documents and their links are book-scoped). Best effort —
    // a failed copy leaves the line without evidence, which the accountable
    // plan check and the Action Center surface.
    try {
      const allDocIds = [...new Set(previews.flatMap((p) => p.documentIds))];
      const copies = await copyDocumentsToBook(input.householdBookGuid, input.businessBookGuid, allDocIds, reportId, ctx.user.id);
      const lines = await prisma.gnucash_web_expense_report_lines.findMany({ where: { report_id: reportId } });
      for (const line of lines) {
        const txDocs = docs.get(line.source_tx_guid) ?? [];
        const copied = txDocs.map((id) => copies.get(id)).filter((id): id is number => id !== undefined);
        if (copied.length > 0) {
          await prisma.gnucash_web_expense_report_lines.update({ where: { id: line.id }, data: { document_ids: copied } });
        }
      }
    } catch (error) {
      console.warn('Expense report document copy failed:', error);
    }

    const report = await loadReport(reportId, input.householdBookGuid);
    await logAudit('CREATE', 'REIMBURSEMENT', `expense-report:${reportId}`, null, {
      report: report.label,
      totalCents: report.totalCents,
      lines: report.lines.length,
    }, { bookGuid: input.householdBookGuid, userId: ctx.user.id });
    return { dryRun: false, lines: previews, totalCents, report };
  });
}

/** Withdraw a report that has not been approved yet; its lines are released. */
export async function withdrawReport(ctx: ExpenseReportContext, householdBookGuid: string, reportId: number): Promise<ReportRecord> {
  await requireBookEdit(ctx, householdBookGuid, 'household');
  const report = await loadReport(reportId, householdBookGuid);
  if (report.householdBookGuid !== householdBookGuid) throw new ExpenseReportError('Expense report not found.', 404);
  if (report.status !== 'submitted') throw new ExpenseReportError('Only a report awaiting approval can be withdrawn.', 409);
  await prisma.gnucash_web_expense_reports.updateMany({
    where: { id: reportId, status: 'submitted' },
    data: { status: 'withdrawn', updated_at: new Date() },
  });
  await logAudit('UPDATE', 'REIMBURSEMENT', `expense-report:${reportId}`, { status: 'submitted' }, { status: 'withdrawn' }, {
    bookGuid: householdBookGuid,
    userId: ctx.user.id,
  });
  return loadReport(reportId, householdBookGuid);
}
