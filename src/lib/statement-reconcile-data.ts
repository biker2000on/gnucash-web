/**
 * Statement Reconcile — DB LOADERS & COMMIT
 *
 * Bridges the pure engine (statement-reconcile.ts) to Postgres. Reads the
 * statement batch + lines produced by the ingestion agent, loads candidate
 * ledger splits, runs the matcher, and (on finalize) writes added transactions
 * and marks reconciled splits.
 *
 * DECOUPLING NOTE: the ingestion agent owns src/lib/services/statement.service.ts
 * and creates the same tables via `ensureStatementTables()`. To stay independent
 * of that module (it lives in a parallel worktree) we read/write the pinned
 * tables directly via raw SQL and defensively ensure them here with the exact
 * pinned schema — `CREATE TABLE IF NOT EXISTS` is idempotent, so both agents'
 * ensure paths coexist safely.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { applyRules } from '@/lib/services/categorization.service';
import { assertNotLocked } from '@/lib/services/period-lock.service';
// Canonical statement table creation lives in statement.service.ts (the
// ingestion owner). Re-exported so this module and its API routes share one
// schema definition instead of a divergent duplicate.
import { ensureStatementTables } from '@/lib/services/statement.service';
export { ensureStatementTables };
import {
  matchStatementLines,
  computeReconcileTieOut,
  splitValueToStatementAmount,
  statementAmountToSplitValue,
  negateSplitValue,
  DEFAULT_MATCH_WINDOW_DAYS,
  type StatementLineInput,
  type LedgerSplitInput,
  type TieOutResult,
} from '@/lib/statement-reconcile';

/* ─────────────────────────── table shapes ─────────────────────────── */

export type StatementBatchStatus =
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'error'
  | 'reconciled';

export type LineMatchState = 'unmatched' | 'matched' | 'added' | 'ignored';

export interface StatementBatchRow {
  id: number;
  book_guid: string;
  account_guid: string | null;
  source: string | null;
  original_filename: string | null;
  status: StatementBatchStatus;
  statement_start_date: Date | null;
  statement_end_date: Date | null;
  opening_balance: number | null;
  closing_balance: number | null;
  currency: string | null;
}

export interface StatementLineRow {
  id: number;
  batch_id: number;
  line_date: Date;
  description: string | null;
  amount: number;
  running_balance: number | null;
  matched_split_guid: string | null;
  match_state: LineMatchState;
  suggested_account_guid: string | null;
}

/** Typed error the API routes map to 404/409. */
export class StatementReconcileError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'no_account' | 'not_ties_out' | 'bad_request',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StatementReconcileError';
  }
}

/* ─────────────────────────── loaders ─────────────────────────── */

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export async function getBatch(batchId: number): Promise<StatementBatchRow | null> {
  await ensureStatementTables();
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, book_guid, account_guid, source, original_filename, status,
           statement_start_date, statement_end_date, opening_balance,
           closing_balance, currency
    FROM gnucash_web_statement_batches
    WHERE id = ${batchId}
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    book_guid: String(r.book_guid),
    account_guid: (r.account_guid as string) ?? null,
    source: (r.source as string) ?? null,
    original_filename: (r.original_filename as string) ?? null,
    status: r.status as StatementBatchStatus,
    statement_start_date: (r.statement_start_date as Date) ?? null,
    statement_end_date: (r.statement_end_date as Date) ?? null,
    opening_balance: num(r.opening_balance),
    closing_balance: num(r.closing_balance),
    currency: (r.currency as string) ?? null,
  };
}

export async function getLines(batchId: number): Promise<StatementLineRow[]> {
  await ensureStatementTables();
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, batch_id, line_date, description, amount, running_balance,
           matched_split_guid, match_state, suggested_account_guid
    FROM gnucash_web_statement_lines
    WHERE batch_id = ${batchId}
    ORDER BY line_date ASC, id ASC
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    batch_id: Number(r.batch_id),
    line_date: r.line_date as Date,
    description: (r.description as string) ?? null,
    amount: Number(r.amount),
    running_balance: num(r.running_balance),
    matched_split_guid: (r.matched_split_guid as string) ?? null,
    match_state: r.match_state as LineMatchState,
    suggested_account_guid: (r.suggested_account_guid as string) ?? null,
  }));
}

export interface CandidateSplit {
  splitGuid: string;
  date: Date;
  amountSigned: number;
  reconcileState: string;
  description: string;
}

/**
 * Load unreconciled/cleared ledger splits in the statement account within the
 * statement window (padded by windowDays). Splits already reconciled ('y') are
 * excluded. Amounts are converted to the "positive = into account" convention.
 */
export async function getCandidateSplits(
  accountGuid: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CandidateSplit[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT s.guid AS split_guid, t.post_date, t.description,
           s.value_num, s.value_denom, s.reconcile_state
    FROM splits s
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE s.account_guid = ${accountGuid}
      AND s.reconcile_state <> 'y'
      AND t.post_date BETWEEN ${rangeStart} AND ${rangeEnd}
    ORDER BY t.post_date ASC, s.guid ASC
  `;
  return rows.map((r) => ({
    splitGuid: String(r.split_guid),
    date: r.post_date as Date,
    amountSigned: splitValueToStatementAmount(
      r.value_num as bigint,
      r.value_denom as bigint,
    ),
    reconcileState: String(r.reconcile_state),
    description: (r.description as string) ?? '',
  }));
}

/* ─────────────────────────── reconcile view ─────────────────────────── */

export interface MatchedPairView {
  lineId: number;
  splitGuid: string;
  /** true when auto-matched by the engine (not an explicit user decision). */
  auto: boolean;
  line: { date: string; description: string; amount: number };
  split: { date: string; description: string; amount: number; reconcileState: string };
}

export interface MissingLineView {
  lineId: number;
  date: string;
  description: string;
  amount: number;
  suggestedAccountGuid: string | null;
  suggestedAccountName: string | null;
  /** 'add' when the user has already decided to add it, else null. */
  decision: 'add' | null;
}

export interface LedgerOnlyView {
  splitGuid: string;
  date: string;
  description: string;
  amount: number;
  reconcileState: string;
}

export interface ReconcileView {
  batch: {
    id: number;
    status: StatementBatchStatus;
    accountGuid: string | null;
    statementStartDate: string | null;
    statementEndDate: string | null;
    openingBalance: number | null;
    closingBalance: number | null;
    currency: string | null;
    originalFilename: string | null;
  };
  matched: MatchedPairView[];
  missing: MissingLineView[];
  inLedgerNotOnStatement: LedgerOnlyView[];
  tieOut: TieOutResult;
  windowDays: number;
}

const iso = (dt: Date | null): string | null => (dt ? dt.toISOString() : null);

/** Widen the statement window on both sides so boundary matches still resolve. */
function computeRange(
  batch: StatementBatchRow,
  lines: StatementLineRow[],
  windowDays: number,
): { start: Date; end: Date } {
  const pad = windowDays * 86_400_000;
  const lineTimes = lines.map((l) => l.line_date.getTime());
  const start = batch.statement_start_date
    ? new Date(batch.statement_start_date.getTime() - pad)
    : new Date((lineTimes.length ? Math.min(...lineTimes) : Date.now()) - pad);
  const end = batch.statement_end_date
    ? new Date(batch.statement_end_date.getTime() + pad)
    : new Date((lineTimes.length ? Math.max(...lineTimes) : Date.now()) + pad);
  return { start, end };
}

/**
 * Build the full reconcile view for a batch: honours persisted per-line
 * decisions (matched / added / ignored), auto-matches the still-unmatched
 * lines against the remaining candidate splits, suggests a counterpart account
 * for each missing line, and computes a live tie-out.
 */
/**
 * The opening balance to reconcile against: the statement's stated opening if
 * present, otherwise the account's already-reconciled balance (sum of splits
 * already marked 'y'). For a first reconciliation this is 0, which lets
 * statements that only carry a closing balance (most CSV/OFX exports) tie out
 * without the user hand-entering an opening balance.
 */
async function effectiveOpeningBalance(batch: StatementBatchRow): Promise<number | null> {
  if (batch.opening_balance != null) return batch.opening_balance;
  if (!batch.account_guid) return null;
  const rows = await prisma.splits.findMany({
    where: { account_guid: batch.account_guid, reconcile_state: 'y' },
    select: { value_num: true, value_denom: true },
  });
  return rows.reduce(
    (s, sp) => s + splitValueToStatementAmount(sp.value_num, sp.value_denom),
    0,
  );
}

export async function buildReconcileView(
  batch: StatementBatchRow,
  options: { windowDays?: number } = {},
): Promise<ReconcileView> {
  const windowDays = options.windowDays ?? DEFAULT_MATCH_WINDOW_DAYS;

  if (!batch.account_guid) {
    throw new StatementReconcileError(
      'Statement batch has no account assigned; cannot reconcile.',
      'no_account',
    );
  }

  const lines = await getLines(batch.id);
  const { start, end } = computeRange(batch, lines, windowDays);
  const candidates = await getCandidateSplits(batch.account_guid, start, end);
  const candidateByGuid = new Map(candidates.map((c) => [c.splitGuid, c]));

  // Partition lines by persisted decision.
  const explicitMatched: StatementLineRow[] = [];
  const decidedAdd: StatementLineRow[] = [];
  const ignored: StatementLineRow[] = [];
  const unmatched: StatementLineRow[] = [];
  for (const l of lines) {
    if (l.match_state === 'matched' && l.matched_split_guid) explicitMatched.push(l);
    else if (l.match_state === 'added') decidedAdd.push(l);
    else if (l.match_state === 'ignored') ignored.push(l);
    else unmatched.push(l);
  }

  // Remove explicitly-locked splits from the auto-match candidate pool.
  const lockedSplits = new Set(
    explicitMatched.map((l) => l.matched_split_guid as string),
  );
  const autoPool = candidates.filter((c) => !lockedSplits.has(c.splitGuid));

  const lineInputs: StatementLineInput[] = unmatched.map((l) => ({
    lineId: l.id,
    date: l.line_date,
    amountSigned: l.amount,
  }));
  const splitInputs: LedgerSplitInput[] = autoPool.map((c) => ({
    splitGuid: c.splitGuid,
    date: c.date,
    amountSigned: c.amountSigned,
    reconcileState: c.reconcileState,
  }));

  const auto = matchStatementLines(lineInputs, splitInputs, { windowDays });

  const linesById = new Map(lines.map((l) => [l.id, l]));

  // ── matched view (explicit + auto) ──
  const matched: MatchedPairView[] = [];
  for (const l of explicitMatched) {
    const c = candidateByGuid.get(l.matched_split_guid as string);
    matched.push({
      lineId: l.id,
      splitGuid: l.matched_split_guid as string,
      auto: false,
      line: { date: l.line_date.toISOString(), description: l.description ?? '', amount: l.amount },
      split: c
        ? { date: c.date.toISOString(), description: c.description, amount: c.amountSigned, reconcileState: c.reconcileState }
        : { date: '', description: '', amount: l.amount, reconcileState: '' },
    });
  }
  for (const m of auto.matched) {
    const l = linesById.get(m.lineId)!;
    const c = candidateByGuid.get(m.splitGuid)!;
    matched.push({
      lineId: m.lineId,
      splitGuid: m.splitGuid,
      auto: true,
      line: { date: l.line_date.toISOString(), description: l.description ?? '', amount: l.amount },
      split: { date: c.date.toISOString(), description: c.description, amount: c.amountSigned, reconcileState: c.reconcileState },
    });
  }

  // ── missing view (auto-unmatched + already-decided adds), with suggestions ──
  const missingLineIds = new Set<number>(auto.missingOnStatement);
  const missing: MissingLineView[] = [];
  const buildMissing = async (l: StatementLineRow, decision: 'add' | null) => {
    let suggestedAccountGuid = l.suggested_account_guid;
    if (!suggestedAccountGuid) {
      try {
        suggestedAccountGuid = await applyRules(batch.book_guid, l.description ?? '');
      } catch {
        suggestedAccountGuid = null;
      }
    }
    let suggestedAccountName: string | null = null;
    if (suggestedAccountGuid) {
      suggestedAccountName = await getAccountName(suggestedAccountGuid);
    }
    missing.push({
      lineId: l.id,
      date: l.line_date.toISOString(),
      description: l.description ?? '',
      amount: l.amount,
      suggestedAccountGuid,
      suggestedAccountName,
      decision,
    });
  };
  for (const l of unmatched) {
    if (missingLineIds.has(l.id)) await buildMissing(l, null);
  }
  for (const l of decidedAdd) {
    await buildMissing(l, 'add');
  }

  // ── ledger-only view ──
  const inLedgerNotOnStatement: LedgerOnlyView[] = auto.inLedgerNotOnStatement.map((guid) => {
    const c = candidateByGuid.get(guid)!;
    return {
      splitGuid: guid,
      date: c.date.toISOString(),
      description: c.description,
      amount: c.amountSigned,
      reconcileState: c.reconcileState,
    };
  });

  // ── tie-out (explicit + auto matched splits + decided adds) ──
  const openingBalance = await effectiveOpeningBalance(batch);
  const matchedSplitsAmount = matched.reduce((s, m) => s + m.split.amount, 0);
  const addedLinesAmount = decidedAdd.reduce((s, l) => s + l.amount, 0);
  const tieOut = computeReconcileTieOut({
    openingBalance,
    closingBalance: batch.closing_balance,
    matchedSplitsAmount,
    addedLinesAmount,
  });

  // ignored lines are intentionally omitted from every bucket.
  void ignored;

  return {
    batch: {
      id: batch.id,
      status: batch.status,
      accountGuid: batch.account_guid,
      statementStartDate: iso(batch.statement_start_date),
      statementEndDate: iso(batch.statement_end_date),
      openingBalance,
      closingBalance: batch.closing_balance,
      currency: batch.currency,
      originalFilename: batch.original_filename,
    },
    matched,
    missing,
    inLedgerNotOnStatement,
    tieOut,
    windowDays,
  };
}

const accountNameCache = new Map<string, string | null>();
async function getAccountName(guid: string): Promise<string | null> {
  if (accountNameCache.has(guid)) return accountNameCache.get(guid)!;
  const rows = await prisma.$queryRaw<Array<{ fullname: string | null }>>`
    SELECT fullname FROM account_hierarchy WHERE guid = ${guid}
  `;
  const name = rows.length ? (rows[0].fullname ?? null) : null;
  accountNameCache.set(guid, name);
  return name;
}

/* ─────────────────────────── line decisions (PUT) ─────────────────────────── */

export interface LineDecisionInput {
  lineId: number;
  decision: 'match' | 'add' | 'ignore';
  matchedSplitGuid?: string;
  counterpartAccountGuid?: string;
}

export interface ApplyDecisionsResult {
  updated: number;
  errors: Array<{ lineId: number; error: string }>;
}

/**
 * Persist per-line decisions.
 *   match  → match_state='matched', matched_split_guid=<split>
 *   add    → match_state='added',   suggested_account_guid=<counterpart>, split cleared
 *   ignore → match_state='ignored', split cleared
 */
export async function applyLineDecisions(
  batchId: number,
  decisions: LineDecisionInput[],
): Promise<ApplyDecisionsResult> {
  await ensureStatementTables();

  const existing = await getLines(batchId);
  const byId = new Map(existing.map((l) => [l.id, l]));
  const errors: ApplyDecisionsResult['errors'] = [];
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (const d of decisions) {
      const line = byId.get(d.lineId);
      if (!line) {
        errors.push({ lineId: d.lineId, error: 'Line not found in this batch' });
        continue;
      }

      if (d.decision === 'match') {
        if (!d.matchedSplitGuid) {
          errors.push({ lineId: d.lineId, error: 'matchedSplitGuid is required for a match decision' });
          continue;
        }
        await tx.$executeRaw`
          UPDATE gnucash_web_statement_lines
          SET match_state = 'matched', matched_split_guid = ${d.matchedSplitGuid}
          WHERE id = ${d.lineId} AND batch_id = ${batchId}
        `;
        updated++;
      } else if (d.decision === 'add') {
        // Keep a previously-suggested account if none is supplied now.
        const counterpart = d.counterpartAccountGuid ?? line.suggested_account_guid;
        await tx.$executeRaw`
          UPDATE gnucash_web_statement_lines
          SET match_state = 'added',
              matched_split_guid = NULL,
              suggested_account_guid = ${counterpart}
          WHERE id = ${d.lineId} AND batch_id = ${batchId}
        `;
        updated++;
      } else if (d.decision === 'ignore') {
        await tx.$executeRaw`
          UPDATE gnucash_web_statement_lines
          SET match_state = 'ignored', matched_split_guid = NULL
          WHERE id = ${d.lineId} AND batch_id = ${batchId}
        `;
        updated++;
      } else {
        errors.push({ lineId: d.lineId, error: `Unknown decision: ${String((d as { decision: unknown }).decision)}` });
      }
    }
  });

  return { updated, errors };
}

/* ─────────────────────────── finalize (POST) ─────────────────────────── */

export interface FinalizeResult {
  added: number;
  matched: number;
  reconciledSplits: number;
  tieOut: TieOutResult;
}

/**
 * Commit the reconcile. Acts on PERSISTED per-line decisions only:
 *   • 'added' lines → create a balanced 2-split transaction (statement account
 *     + chosen counterpart), then mark the statement split reconciled.
 *   • 'matched' lines → mark the matched split reconciled.
 * REQUIRES the tie-out to pass (tiesOut === true) or throws not_ties_out.
 * Everything runs in one DB transaction. On success the batch → 'reconciled'.
 */
export async function finalizeReconcile(batch: StatementBatchRow): Promise<FinalizeResult> {
  if (!batch.account_guid) {
    throw new StatementReconcileError('Statement batch has no account assigned.', 'no_account');
  }
  const accountGuid = batch.account_guid;

  // Account currency + precision for the added splits.
  const account = await prisma.accounts.findUnique({
    where: { guid: accountGuid },
    select: { commodity_guid: true, commodity_scu: true },
  });
  if (!account || !account.commodity_guid) {
    throw new StatementReconcileError(
      'Statement account has no currency assigned.',
      'bad_request',
    );
  }
  const currencyGuid = account.commodity_guid;
  const denom = account.commodity_scu || 100;

  const lines = await getLines(batch.id);
  const explicitMatched = lines.filter((l) => l.match_state === 'matched' && l.matched_split_guid);
  const addedLines = lines.filter((l) => l.match_state === 'added');

  // Every add line must have a counterpart account.
  const missingCounterpart = addedLines.filter((l) => !l.suggested_account_guid);
  if (missingCounterpart.length > 0) {
    throw new StatementReconcileError(
      `Cannot finalize: ${missingCounterpart.length} line(s) marked 'add' have no counterpart account.`,
      'bad_request',
      { lineIds: missingCounterpart.map((l) => l.id) },
    );
  }

  // Period lock: 'added' lines create transactions dated at the line date,
  // so none of them may fall in a closed period.
  await assertNotLocked(batch.book_guid, addedLines.map((l) => l.line_date));

  // Effective matches = explicitly-confirmed matches PLUS the engine's
  // auto-matches. The reconcile view shows auto-matches and its tie-out counts
  // them, so finalize must too — otherwise the displayed "Balances" banner
  // disagrees with finalize. Re-derive the auto-matches here (same logic as
  // buildReconcileView) and persist them so finalize is authoritative even if
  // the UI never PUT them as confirmations. A line the user set to 'ignore' or
  // 'add' is excluded from auto-matching.
  const decidedIds = new Set<number>([
    ...explicitMatched.map((l) => l.id),
    ...addedLines.map((l) => l.id),
    ...lines.filter((l) => l.match_state === 'ignored').map((l) => l.id),
  ]);
  const undecided = lines.filter((l) => !decidedIds.has(l.id));
  const { start, end } = computeRange(batch, lines, DEFAULT_MATCH_WINDOW_DAYS);
  const candidates = await getCandidateSplits(batch.account_guid, start, end);
  const lockedSplits = new Set(explicitMatched.map((l) => l.matched_split_guid as string));
  const autoPool = candidates.filter((c) => !lockedSplits.has(c.splitGuid));
  const auto = matchStatementLines(
    undecided.map((l) => ({ lineId: l.id, date: l.line_date, amountSigned: l.amount })),
    autoPool.map((c) => ({ splitGuid: c.splitGuid, date: c.date, amountSigned: c.amountSigned, reconcileState: c.reconcileState })),
    { windowDays: DEFAULT_MATCH_WINDOW_DAYS },
  );
  const autoMatches = auto.matched; // [{ lineId, splitGuid }]

  const matchedSplitGuids = [
    ...explicitMatched.map((l) => l.matched_split_guid as string),
    ...autoMatches.map((m) => m.splitGuid),
  ];
  let matchedSplitsAmount = 0;
  if (matchedSplitGuids.length > 0) {
    const splits = await prisma.splits.findMany({
      where: { guid: { in: matchedSplitGuids } },
      select: { value_num: true, value_denom: true },
    });
    matchedSplitsAmount = splits.reduce(
      (s, sp) => s + splitValueToStatementAmount(sp.value_num, sp.value_denom),
      0,
    );
  }
  const addedLinesAmount = addedLines.reduce((s, l) => s + l.amount, 0);

  const openingBalance = await effectiveOpeningBalance(batch);
  const tieOut = computeReconcileTieOut({
    openingBalance,
    closingBalance: batch.closing_balance,
    matchedSplitsAmount,
    addedLinesAmount,
  });

  if (tieOut.tiesOut !== true) {
    throw new StatementReconcileError(
      tieOut.tiesOut === null
        ? 'Cannot finalize: statement opening/closing balance missing, tie-out unverifiable.'
        : 'Cannot finalize: reconcile does not tie out to the statement closing balance.',
      'not_ties_out',
      tieOut,
    );
  }

  const reconcileDate = batch.statement_end_date ?? new Date();
  const enterDate = new Date();

  const statementSplitGuids: string[] = [...matchedSplitGuids];

  await prisma.$transaction(async (tx) => {
    // Persist the engine's auto-matches so the line records reflect what was
    // reconciled (the UI may never have PUT them as explicit confirmations).
    for (const m of autoMatches) {
      await tx.$executeRaw`
        UPDATE gnucash_web_statement_lines
        SET match_state = 'matched', matched_split_guid = ${m.splitGuid}
        WHERE id = ${m.lineId}
      `;
    }

    // Create a balanced 2-split transaction for each added line.
    for (const line of addedLines) {
      const counterpartGuid = line.suggested_account_guid as string;
      const txGuid = generateGuid();
      const stmtSplitGuid = generateGuid();
      const counterSplitGuid = generateGuid();

      const stmtValue = statementAmountToSplitValue(line.amount, denom);
      const counterValue = negateSplitValue(stmtValue);
      const description = line.description || 'Statement import';

      await tx.transactions.create({
        data: {
          guid: txGuid,
          currency_guid: currencyGuid,
          num: '',
          post_date: line.line_date,
          enter_date: enterDate,
          description,
        },
      });

      // Statement-account split (created 'n'; reconciled below in bulk).
      await tx.splits.create({
        data: {
          guid: stmtSplitGuid,
          tx_guid: txGuid,
          account_guid: accountGuid,
          memo: '',
          action: '',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: stmtValue.num,
          value_denom: stmtValue.denom,
          quantity_num: stmtValue.num,
          quantity_denom: stmtValue.denom,
          lot_guid: null,
        },
      });

      // Counterpart split (not part of this account's reconcile).
      await tx.splits.create({
        data: {
          guid: counterSplitGuid,
          tx_guid: txGuid,
          account_guid: counterpartGuid,
          memo: '',
          action: '',
          reconcile_state: 'n',
          reconcile_date: null,
          value_num: counterValue.num,
          value_denom: counterValue.denom,
          quantity_num: counterValue.num,
          quantity_denom: counterValue.denom,
          lot_guid: null,
        },
      });

      // Link the line to its newly-created statement split.
      await tx.$executeRaw`
        UPDATE gnucash_web_statement_lines
        SET match_state = 'added', matched_split_guid = ${stmtSplitGuid}
        WHERE id = ${line.id}
      `;

      statementSplitGuids.push(stmtSplitGuid);
    }

    // Bulk mark reconciled (same path as /api/splits/bulk/reconcile).
    if (statementSplitGuids.length > 0) {
      await tx.splits.updateMany({
        where: { guid: { in: statementSplitGuids } },
        data: { reconcile_state: 'y', reconcile_date: reconcileDate },
      });
    }

    // Flip the batch to reconciled.
    await tx.$executeRaw`
      UPDATE gnucash_web_statement_batches
      SET status = 'reconciled', updated_at = NOW()
      WHERE id = ${batch.id}
    `;
  });

  return {
    added: addedLines.length,
    matched: matchedSplitGuids.length,
    reconciledSplits: statementSplitGuids.length,
    tieOut,
  };
}
