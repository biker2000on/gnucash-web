/**
 * Statement Service
 *
 * Owns the two shared tables for the "Statement Import & Reconcile" feature:
 *   - gnucash_web_statement_batches  (one uploaded statement file)
 *   - gnucash_web_statement_lines    (one parsed transaction line)
 *
 * Both tables are created lazily via an advisory-lock guarded CREATE TABLE
 * (the same pattern as src/lib/notifications.ts) and are NOT part of the
 * Prisma schema — all access goes through prisma.$queryRaw / $executeRaw.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AMOUNT SIGN CONVENTION (shared with the reconcile engine — do not deviate)
 * ─────────────────────────────────────────────────────────────────────────
 *   statement_lines.amount is SIGNED:
 *     • POSITIVE  = money INTO the account   (deposit / credit / payment received)
 *     • NEGATIVE  = money OUT of the account (withdrawal / debit / purchase)
 *   This mirrors the OFX TRNAMT convention. All parsers normalize to this.
 */

import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Types (camelCase in TS; snake_case in the DB)
// ---------------------------------------------------------------------------

export type StatementSource = 'pdf' | 'csv' | 'ofx';
export type StatementStatus =
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'error'
  | 'reconciled';
export type MatchState = 'unmatched' | 'matched' | 'added' | 'ignored';

export interface StatementBatch {
  id: number;
  bookGuid: string;
  accountGuid: string | null;
  source: StatementSource;
  originalFilename: string;
  storageKey: string;
  thumbnailKey: string | null;
  status: StatementStatus;
  statementStartDate: Date | null;
  statementEndDate: Date | null;
  openingBalance: number | null;
  closingBalance: number | null;
  currency: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatementBatchWithCount extends StatementBatch {
  lineCount: number;
}

export interface StatementLine {
  id: number;
  batchId: number;
  /** Signed: positive = into account, negative = out of account. */
  amount: number;
  lineDate: Date;
  description: string;
  runningBalance: number | null;
  matchedSplitGuid: string | null;
  matchState: MatchState;
  suggestedAccountGuid: string | null;
  createdAt: Date;
}

/** Input shape for a single parsed line (fed into replaceLines). */
export interface StatementLineInput {
  /** ISO date string 'YYYY-MM-DD'. */
  date: string;
  description: string;
  /** Signed: positive = into account, negative = out of account. */
  amount: number;
  runningBalance?: number | null;
  matchedSplitGuid?: string | null;
  matchState?: MatchState;
  suggestedAccountGuid?: string | null;
}

export interface CreateBatchInput {
  bookGuid: string;
  accountGuid?: string | null;
  source: StatementSource;
  originalFilename: string;
  storageKey: string;
  thumbnailKey?: string | null;
  status?: StatementStatus;
}

/** Fields settable alongside a status change (all optional). */
export interface BatchStatusPatch {
  accountGuid?: string | null;
  statementStartDate?: string | null;
  statementEndDate?: string | null;
  openingBalance?: number | null;
  closingBalance?: number | null;
  currency?: string | null;
  error?: string | null;
}

/** Partial update for a single statement line. */
export interface StatementLinePatch {
  date?: string;
  description?: string;
  amount?: number;
  runningBalance?: number | null;
  matchedSplitGuid?: string | null;
  matchState?: MatchState;
  suggestedAccountGuid?: string | null;
}

// ---------------------------------------------------------------------------
// Row shapes (as returned by raw SQL) + mappers
// ---------------------------------------------------------------------------

interface BatchRow {
  id: number;
  book_guid: string;
  account_guid: string | null;
  source: string;
  original_filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  status: string;
  statement_start_date: Date | null;
  statement_end_date: Date | null;
  opening_balance: unknown;
  closing_balance: unknown;
  currency: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  line_count?: unknown;
}

interface LineRow {
  id: number;
  batch_id: number;
  line_date: Date;
  description: string;
  amount: unknown;
  running_balance: unknown;
  matched_split_guid: string | null;
  match_state: string;
  suggested_account_guid: string | null;
  created_at: Date;
}

/** Coerce a NUMERIC column (string | Prisma.Decimal | number | null) to number | null. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapBatchRow(row: BatchRow): StatementBatch {
  return {
    id: row.id,
    bookGuid: row.book_guid,
    accountGuid: row.account_guid,
    source: row.source as StatementSource,
    originalFilename: row.original_filename,
    storageKey: row.storage_key,
    thumbnailKey: row.thumbnail_key,
    status: row.status as StatementStatus,
    statementStartDate: row.statement_start_date,
    statementEndDate: row.statement_end_date,
    openingBalance: numOrNull(row.opening_balance),
    closingBalance: numOrNull(row.closing_balance),
    currency: row.currency,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLineRow(row: LineRow): StatementLine {
  return {
    id: row.id,
    batchId: row.batch_id,
    lineDate: row.line_date,
    description: row.description,
    amount: numOrNull(row.amount) ?? 0,
    runningBalance: numOrNull(row.running_balance),
    matchedSplitGuid: row.matched_split_guid,
    matchState: row.match_state as MatchState,
    suggestedAccountGuid: row.suggested_account_guid,
    createdAt: row.created_at,
  };
}

const BATCH_COLS = `
  id, book_guid, account_guid, source, original_filename, storage_key,
  thumbnail_key, status, statement_start_date, statement_end_date,
  opening_balance, closing_balance, currency, error, created_at, updated_at
`;

const LINE_COLS = `
  id, batch_id, line_date, description, amount, running_balance,
  matched_split_guid, match_state, suggested_account_guid, created_at
`;

// ---------------------------------------------------------------------------
// Lazy table creation (advisory-lock guarded, mirrors notifications.ts)
// ---------------------------------------------------------------------------

let ensurePromise: Promise<void> | null = null;

export function ensureStatementTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_statement_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_statement_batches (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            account_guid VARCHAR(32),
            source VARCHAR(8) NOT NULL,
            original_filename TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            thumbnail_key TEXT,
            status VARCHAR(16) NOT NULL DEFAULT 'uploaded',
            statement_start_date DATE,
            statement_end_date DATE,
            opening_balance NUMERIC,
            closing_balance NUMERIC,
            currency VARCHAR(16),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE INDEX IF NOT EXISTS idx_statement_batches_book
            ON gnucash_web_statement_batches(book_guid, created_at DESC);

          CREATE TABLE IF NOT EXISTS gnucash_web_statement_lines (
            id SERIAL PRIMARY KEY,
            batch_id INTEGER NOT NULL,
            line_date DATE NOT NULL,
            description TEXT NOT NULL,
            amount NUMERIC NOT NULL,
            running_balance NUMERIC,
            matched_split_guid VARCHAR(32),
            match_state VARCHAR(12) NOT NULL DEFAULT 'unmatched',
            suggested_account_guid VARCHAR(32),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );

          CREATE INDEX IF NOT EXISTS idx_statement_lines_batch
            ON gnucash_web_statement_lines(batch_id);
        END $$;
      `);
    })();
  }
  return ensurePromise;
}

// ---------------------------------------------------------------------------
// Batch CRUD
// ---------------------------------------------------------------------------

export async function createBatch(input: CreateBatchInput): Promise<StatementBatch> {
  await ensureStatementTables();
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(
    `
      INSERT INTO gnucash_web_statement_batches
        (book_guid, account_guid, source, original_filename, storage_key, thumbnail_key, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING ${BATCH_COLS}
    `,
    input.bookGuid,
    input.accountGuid ?? null,
    input.source,
    input.originalFilename,
    input.storageKey,
    input.thumbnailKey ?? null,
    input.status ?? 'uploaded',
  );
  return mapBatchRow(rows[0]);
}

/**
 * Fetch a single batch by id.
 *
 * If `bookAccountGuids` is provided, the batch is scoped to the active book:
 * a batch whose account_guid is set but NOT in the list is treated as
 * out-of-book (returns null). Batches with a null account_guid (not yet
 * assigned to an account) are always returned — callers that need strict
 * book isolation should additionally check `batch.bookGuid`.
 */
export async function getBatch(
  id: number,
  bookAccountGuids?: string[],
): Promise<StatementBatch | null> {
  await ensureStatementTables();
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(
    `SELECT ${BATCH_COLS} FROM gnucash_web_statement_batches WHERE id = $1`,
    id,
  );
  if (rows.length === 0) return null;
  const batch = mapBatchRow(rows[0]);
  if (bookAccountGuids && batch.accountGuid && !bookAccountGuids.includes(batch.accountGuid)) {
    return null;
  }
  return batch;
}

export async function listBatches(bookGuid: string): Promise<StatementBatchWithCount[]> {
  await ensureStatementTables();
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(
    `
      SELECT ${BATCH_COLS},
        (SELECT COUNT(*) FROM gnucash_web_statement_lines l WHERE l.batch_id = b.id) AS line_count
      FROM gnucash_web_statement_batches b
      WHERE b.book_guid = $1
      ORDER BY b.created_at DESC
    `,
    bookGuid,
  );
  return rows.map((row) => ({
    ...mapBatchRow(row),
    lineCount: Number(row.line_count ?? 0),
  }));
}

/** Update a batch's status, optionally patching account/dates/balances/currency/error. */
export async function setBatchStatus(
  id: number,
  status: StatementStatus,
  patch: BatchStatusPatch = {},
): Promise<StatementBatch | null> {
  await ensureStatementTables();

  const sets: string[] = ['status = $1', 'updated_at = now()'];
  const params: unknown[] = [status];
  let i = 2;
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${i}`);
    params.push(val);
    i++;
  };

  if ('accountGuid' in patch) add('account_guid', patch.accountGuid ?? null);
  if ('statementStartDate' in patch) add('statement_start_date', patch.statementStartDate ?? null);
  if ('statementEndDate' in patch) add('statement_end_date', patch.statementEndDate ?? null);
  if ('openingBalance' in patch) add('opening_balance', patch.openingBalance ?? null);
  if ('closingBalance' in patch) add('closing_balance', patch.closingBalance ?? null);
  if ('currency' in patch) add('currency', patch.currency ?? null);
  if ('error' in patch) add('error', patch.error ?? null);

  params.push(id);
  const rows = await prisma.$queryRawUnsafe<BatchRow[]>(
    `
      UPDATE gnucash_web_statement_batches
      SET ${sets.join(', ')}
      WHERE id = $${i}
      RETURNING ${BATCH_COLS}
    `,
    ...params,
  );
  return rows[0] ? mapBatchRow(rows[0]) : null;
}

export async function deleteBatch(id: number): Promise<void> {
  await ensureStatementTables();
  await prisma.$executeRaw`DELETE FROM gnucash_web_statement_lines WHERE batch_id = ${id}`;
  await prisma.$executeRaw`DELETE FROM gnucash_web_statement_batches WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Line CRUD
// ---------------------------------------------------------------------------

/** Replace ALL lines for a batch with the provided set. Returns the count inserted. */
export async function replaceLines(
  batchId: number,
  lines: StatementLineInput[],
): Promise<number> {
  await ensureStatementTables();
  await prisma.$executeRaw`DELETE FROM gnucash_web_statement_lines WHERE batch_id = ${batchId}`;
  if (lines.length === 0) return 0;

  const params: unknown[] = [];
  const tuples = lines.map((l, idx) => {
    const b = idx * 8;
    params.push(
      batchId,
      l.date,
      l.description,
      l.amount,
      l.runningBalance ?? null,
      l.matchedSplitGuid ?? null,
      l.matchState ?? 'unmatched',
      l.suggestedAccountGuid ?? null,
    );
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
  });

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO gnucash_web_statement_lines
        (batch_id, line_date, description, amount, running_balance, matched_split_guid, match_state, suggested_account_guid)
      VALUES ${tuples.join(', ')}
    `,
    ...params,
  );
  return lines.length;
}

/** List all lines for a batch, ordered by date then id. */
export async function listLines(batchId: number): Promise<StatementLine[]> {
  await ensureStatementTables();
  const rows = await prisma.$queryRawUnsafe<LineRow[]>(
    `SELECT ${LINE_COLS} FROM gnucash_web_statement_lines WHERE batch_id = $1 ORDER BY line_date ASC, id ASC`,
    batchId,
  );
  return rows.map(mapLineRow);
}

/** Patch a single line. Returns the updated line, or null if not found / no-op. */
export async function updateLine(
  id: number,
  patch: StatementLinePatch,
): Promise<StatementLine | null> {
  await ensureStatementTables();

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${i}`);
    params.push(val);
    i++;
  };

  if ('date' in patch) add('line_date', patch.date);
  if ('description' in patch) add('description', patch.description);
  if ('amount' in patch) add('amount', patch.amount);
  if ('runningBalance' in patch) add('running_balance', patch.runningBalance ?? null);
  if ('matchedSplitGuid' in patch) add('matched_split_guid', patch.matchedSplitGuid ?? null);
  if ('matchState' in patch) add('match_state', patch.matchState);
  if ('suggestedAccountGuid' in patch) add('suggested_account_guid', patch.suggestedAccountGuid ?? null);

  if (sets.length === 0) {
    // Nothing to update — return the current row.
    const rows = await prisma.$queryRawUnsafe<LineRow[]>(
      `SELECT ${LINE_COLS} FROM gnucash_web_statement_lines WHERE id = $1`,
      id,
    );
    return rows[0] ? mapLineRow(rows[0]) : null;
  }

  params.push(id);
  const rows = await prisma.$queryRawUnsafe<LineRow[]>(
    `
      UPDATE gnucash_web_statement_lines
      SET ${sets.join(', ')}
      WHERE id = $${i}
      RETURNING ${LINE_COLS}
    `,
    ...params,
  );
  return rows[0] ? mapLineRow(rows[0]) : null;
}
