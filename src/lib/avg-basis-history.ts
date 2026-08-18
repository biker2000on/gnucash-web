/**
 * DURABLE WRITE HISTORY FOR POOLED (AVERAGE-COST) BASIS.
 *
 * Every average-cost scrub run re-prices every open lot it can see, so a lot
 * accumulates one pooled-basis WRITE per run. Reverting one run must restore
 * the value the run it reverted had displaced — at any depth, in any order —
 * or the lot falls back to its own purchase cost while an earlier run's
 * disposal slot still says part of that cost was already spent. That is a
 * double-count that understates every later gain, on a filed return, with no
 * error and no visible symptom.
 *
 * ## Why the history is NOT in a GnuCash slot
 *
 * It used to be: one `avg_cost_basis_remaining_prev` slot holding the whole
 * stack as a JSON array. `slots.string_val` is VARCHAR(4096), which caps that
 * at roughly 48-80 writes per lot, and the over-cap behaviour was to DROP the
 * oldest entries with a `console.warn`. Reverting an old run then landed on
 * exactly the wrong-number-on-a-filed-return the provenance exists to prevent,
 * merely relocated to depth — and a warning on a server log is not a signal a
 * user can act on. One malformed character was worse still: `JSON.parse` fails
 * on the whole document, so a single bad byte erased the entire stack.
 *
 * This table has no length ceiling and stores ONE ROW PER WRITE, so a damaged
 * row costs exactly that one entry instead of all of them. It is also
 * app-owned — `gnucash_web_*`, outside the schema GnuCash desktop manages — so
 * unlike a multi-row `slots` history (which desktop would silently fold into a
 * single KVP entry on a round trip) nothing outside this app rewrites it.
 *
 * ## What stays in the slot
 *
 * The TOP of the stack is still materialized into `avg_cost_basis_remaining`
 * (and its `_run` companion) exactly as before. That slot remains the fast
 * path every reader uses — `lots.ts`, `openingBasisForExistingLot`, Form 8949
 * — and keeps the book coherent when it is opened in GnuCash desktop. The
 * table is the durable history behind it; the slot is a mirror of its top row.
 *
 * @see lot-scrub.ts for the slot names and the stack semantics.
 */
import prisma from './prisma';
import type { PrismaTx } from './lot-scrub';

/** App-owned table holding one row per pooled-basis write. */
export const AVG_BASIS_HISTORY_TABLE = 'gnucash_web_avg_basis_history';

/**
 * One write of a lot's pooled remaining basis: the value, and the run that
 * wrote it (`null` only for a legacy value written before provenance existed).
 */
export interface AvgBasisWrite {
  run: string | null;
  /** The formatted slot value, kept as written so a restore is byte-identical. */
  value: string;
  /**
   * Set when the stored row could not be read as a number. The entry is KEPT
   * (its position and its owner are still meaningful, and dropping it would
   * silently renumber the stack) but it can never be materialized into the
   * live slot — see {@link AvgBasisHistoryRepairRequiredError}.
   */
  corrupt?: boolean;
}

/**
 * True when a stored value is not a usable basis figure.
 *
 * Deliberately stricter than the `parseFloat` every reader uses: parseFloat
 * stops at the first bad character, so a damaged `"20 00"` reads back as a
 * perfectly plausible 20 - the silent wrong number this whole area exists to
 * remove. Number() rejects anything that is not wholly numeric.
 */
export const isCorruptBasisValue = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed === '' || !Number.isFinite(Number(trimmed));
};

/**
 * Raised instead of returning a confidently wrong number.
 *
 * The alternative — falling back to the lot's own purchase cost — produces a
 * plausible figure that lands on Form 8949 and is simply incorrect. A loud
 * failure naming the lot is recoverable: re-scrubbing the account under the
 * average election rebuilds the pooled basis from the transactions, which are
 * never what is damaged here.
 */
export class AvgBasisHistoryRepairRequiredError extends Error {
  readonly code = 'AVG_BASIS_HISTORY_REPAIR_REQUIRED';
  constructor(
    readonly lotGuid: string,
    readonly reason: string,
  ) {
    super(
      `Average-cost basis history for lot ${lotGuid} cannot be read (${reason}). ` +
      `Refusing to fall back to the lot's own purchase cost: that would report a ` +
      `wrong cost basis on Form 8949 without any error. Re-run the average-cost ` +
      `scrub on this account to rebuild the pooled basis from the transactions, ` +
      `then retry.`,
    );
    this.name = 'AvgBasisHistoryRepairRequiredError';
  }
}

/* ------------------------------------------------------------------ */
/* Lazy table creation                                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

/**
 * Create the history table if it is not there yet. Same shape as the repo's
 * other app-owned tables (see `ensureScheduleFMappingsTable`): idempotent DDL
 * behind an advisory lock, memoized per process, and un-memoized on failure so
 * a transient error does not poison the process.
 *
 * Callers that own a transaction should call this BEFORE opening it — the DDL
 * runs on its own connection.
 */
export function ensureAvgBasisHistoryTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_avg_basis_history_schema'));

          CREATE TABLE IF NOT EXISTS gnucash_web_avg_basis_history (
            lot_guid   VARCHAR(32) NOT NULL,
            seq_no     INTEGER     NOT NULL,
            run_id     VARCHAR(32),
            basis_val  TEXT        NOT NULL,
            written_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (lot_guid, seq_no)
          );

          CREATE INDEX IF NOT EXISTS idx_avg_basis_history_run
            ON gnucash_web_avg_basis_history(run_id);
        END $$;
      `);
    })();
    ensurePromise.catch(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Read / write                                                         */
/* ------------------------------------------------------------------ */

interface HistoryRow {
  seq_no: number;
  run_id: string | null;
  basis_val: string;
}

/**
 * The whole write stack for one lot, oldest first. The last entry is the live
 * value mirrored into `avg_cost_basis_remaining`.
 */
export async function readAvgBasisHistory(
  lotGuid: string,
  tx: PrismaTx,
): Promise<AvgBasisWrite[]> {
  await ensureAvgBasisHistoryTable();
  const rows = (await tx.$queryRaw<HistoryRow[]>`
    /* gnucash_web_avg_basis_history: select-stack */
    SELECT seq_no, run_id, basis_val
      FROM gnucash_web_avg_basis_history
     WHERE lot_guid = ${lotGuid}
     ORDER BY seq_no ASC
  `) ?? [];
  return rows.map(row => {
    const value = row.basis_val ?? '';
    const entry: AvgBasisWrite = { run: row.run_id ?? null, value };
    // One unreadable row is one unreadable entry. Everything around it stands
    // — the whole point of a row per write rather than one JSON document.
    if (isCorruptBasisValue(value)) entry.corrupt = true;
    return entry;
  });
}

/** Replace a lot's whole stack. Used by the revert path; renumbers from 0. */
export async function replaceAvgBasisHistory(
  lotGuid: string,
  stack: readonly AvgBasisWrite[],
  tx: PrismaTx,
): Promise<void> {
  await ensureAvgBasisHistoryTable();
  await deleteAvgBasisHistoryForLots([lotGuid], tx);
  for (let i = 0; i < stack.length; i++) {
    await tx.$executeRaw`
      /* gnucash_web_avg_basis_history: insert-at */
      INSERT INTO gnucash_web_avg_basis_history (lot_guid, seq_no, run_id, basis_val)
      VALUES (${lotGuid}, ${i}, ${stack[i].run}, ${stack[i].value})
      ON CONFLICT (lot_guid, seq_no) DO UPDATE
        SET run_id = EXCLUDED.run_id, basis_val = EXCLUDED.basis_val
    `;
  }
}

/**
 * Push one write onto the end of a lot's stack. The hot path: a scrub run
 * re-pricing an open lot costs exactly one INSERT, whatever the depth.
 */
export async function appendAvgBasisHistory(
  lotGuid: string,
  entry: AvgBasisWrite,
  tx: PrismaTx,
): Promise<void> {
  await ensureAvgBasisHistoryTable();
  await tx.$executeRaw`
    /* gnucash_web_avg_basis_history: append */
    INSERT INTO gnucash_web_avg_basis_history (lot_guid, seq_no, run_id, basis_val)
    SELECT ${lotGuid}, COALESCE(MAX(seq_no) + 1, 0), ${entry.run}, ${entry.value}
      FROM gnucash_web_avg_basis_history
     WHERE lot_guid = ${lotGuid}
  `;
}

/**
 * Drop the top entry when this run already owns it. One run touching the same
 * lot twice is ONE write, not two: the second value supersedes the first and
 * both would be dropped by the same revert.
 */
export async function popAvgBasisHistoryTopForRun(
  lotGuid: string,
  runId: string,
  tx: PrismaTx,
): Promise<void> {
  await ensureAvgBasisHistoryTable();
  await tx.$executeRaw`
    /* gnucash_web_avg_basis_history: pop-top-for-run */
    DELETE FROM gnucash_web_avg_basis_history h
     WHERE h.lot_guid = ${lotGuid}
       AND h.run_id = ${runId}
       AND h.seq_no = (
         SELECT MAX(i.seq_no) FROM gnucash_web_avg_basis_history i
          WHERE i.lot_guid = ${lotGuid}
       )
  `;
}

/** Forget everything recorded for these lots. */
export async function deleteAvgBasisHistoryForLots(
  lotGuids: readonly string[],
  tx: PrismaTx,
): Promise<void> {
  if (lotGuids.length === 0) return;
  await ensureAvgBasisHistoryTable();
  await tx.$executeRaw`
    /* gnucash_web_avg_basis_history: delete-lots */
    DELETE FROM gnucash_web_avg_basis_history
     WHERE lot_guid = ANY(${[...lotGuids]}::text[])
  `;
}

/**
 * Lots carrying a write owned by this run, live or displaced.
 *
 * Indexed on `run_id`. The slot-era version had to read EVERY lot's history
 * document and JSON-decode it to answer this.
 */
export async function lotsWithAvgBasisHistoryForRun(
  runId: string,
  tx: PrismaTx,
): Promise<string[]> {
  await ensureAvgBasisHistoryTable();
  const rows = (await tx.$queryRaw<Array<{ lot_guid: string }>>`
    /* gnucash_web_avg_basis_history: lots-for-run */
    SELECT DISTINCT lot_guid
      FROM gnucash_web_avg_basis_history
     WHERE run_id = ${runId}
  `) ?? [];
  return rows.map(r => r.lot_guid);
}

/** Whether this lot has any recorded write at all. */
export async function hasAvgBasisHistory(lotGuid: string, tx: PrismaTx): Promise<boolean> {
  await ensureAvgBasisHistoryTable();
  const rows = (await tx.$queryRaw<Array<{ present: number }>>`
    /* gnucash_web_avg_basis_history: exists */
    SELECT 1 AS present
      FROM gnucash_web_avg_basis_history
     WHERE lot_guid = ${lotGuid}
     LIMIT 1
  `) ?? [];
  return rows.length > 0;
}
