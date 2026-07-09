/**
 * Statement Matching & Reconcile — PURE ENGINE
 *
 * No database access. Every function here is deterministic and unit-tested.
 * The data/API layers (statement-reconcile-data.ts and the /api/statements
 * routes) load rows from Postgres, convert them into the plain shapes below,
 * call these functions, and persist the results.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIGN CONVENTION (the crux of the whole feature)
 * ─────────────────────────────────────────────────────────────────────────
 * Statement lines use a single signed amount where **positive = money INTO
 * the account** (the balance moves up), negative = money out.
 *
 * GnuCash stores a split's `value_num / value_denom` as a *debit-positive*
 * signed value: a debit is positive, a credit is negative, and the account's
 * raw balance is simply the sum of its splits' values. That raw sign already
 * encodes "increases the account balance = positive", so it maps DIRECTLY onto
 * the statement convention for EVERY account type — no per-account-type
 * branching is required:
 *
 *   Asset / Bank / Cash / Receivable (natural debit balance)
 *     • deposit  → debit  → value_num > 0 → statement amount > 0  (money in)  ✓
 *     • withdraw → credit → value_num < 0 → statement amount < 0  (money out) ✓
 *
 *   Liability / Credit Card / Payable (natural credit balance)
 *     • charge   → credit → value_num < 0 → statement amount < 0  (money out) ✓
 *         (a charge INCREASES what you owe, i.e. it REDUCES the raw
 *          debit-positive account balance → negative → "money out")
 *     • payment  → debit  → value_num > 0 → statement amount > 0  (money in)  ✓
 *         (a payment pays the card down, moving the raw balance up → positive)
 *
 * So `splitValueToStatementAmount()` is just the native decimal of the raw
 * value with NO type-dependent negation. (This is the same convention the
 * SimpleFIN importer uses: its bank split gets a positive value_num when money
 * comes in.) NOTE: this operates on the *raw* stored value. If a caller ever
 * had a *display* balance instead — where GnuCash flips the sign of liabilities
 * so a credit-card balance shows as a positive "you owe" number — that would
 * need negation for liabilities. We never do; we always read raw split values.
 */

/** Amounts are considered equal within half a cent (float tolerance). */
export const AMOUNT_EPSILON = 0.005;

/** Default +/- day window for line↔split date matching. */
export const DEFAULT_MATCH_WINDOW_DAYS = 4;

/** A statement line reduced to what the matcher needs. */
export interface StatementLineInput {
  /** Stable identifier for the line (DB row id). */
  lineId: number;
  /** Calendar date the line posted. */
  date: Date;
  /** Signed amount, positive = money INTO the account. */
  amountSigned: number;
}

/** An existing unreconciled/cleared ledger split in the statement's account. */
export interface LedgerSplitInput {
  splitGuid: string;
  /** Transaction post date. */
  date: Date;
  /** Signed amount in the same "positive = into account" convention. */
  amountSigned: number;
  /** GnuCash reconcile state: 'n' | 'c' | 'y'. Informational only. */
  reconcileState?: string;
}

export interface MatchedPair {
  lineId: number;
  splitGuid: string;
}

export interface MatchResult {
  /** 1:1 line↔split pairs, equal amount within the date window. */
  matched: MatchedPair[];
  /**
   * Line ids present on the statement with NO ledger match. These are
   * candidates to ADD to the ledger (money that hit the bank but was never
   * entered). Named for the statement's point of view.
   */
  missingOnStatement: number[];
  /**
   * Split guids present in the ledger but NOT on the statement (e.g. a check
   * that hasn't cleared yet). Left reconcile_state='n'; not reconciled.
   */
  inLedgerNotOnStatement: string[];
}

/** Whole-day absolute distance between two dates. */
function dayDistance(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/**
 * Greedy 1:1 matcher.
 *
 * For each statement line (processed earliest-date-first for determinism) we
 * find every not-yet-used ledger split whose amount equals the line amount
 * (within AMOUNT_EPSILON) and whose date is within +/- windowDays. The closest
 * date wins; ties break by earliest split date then split guid. Each split is
 * consumed by at most one line.
 *
 * @param lines statement lines
 * @param ledgerSplits candidate splits already scoped to the account + range
 * @param options.windowDays +/- day tolerance (default 4)
 */
export function matchStatementLines(
  lines: StatementLineInput[],
  ledgerSplits: LedgerSplitInput[],
  options: { windowDays?: number } = {},
): MatchResult {
  const windowDays = options.windowDays ?? DEFAULT_MATCH_WINDOW_DAYS;

  const matched: MatchedPair[] = [];
  const usedSplits = new Set<string>();
  const matchedLineIds = new Set<number>();

  // Deterministic processing order: earliest line first, then by lineId.
  const orderedLines = [...lines].sort((a, b) => {
    const dt = a.date.getTime() - b.date.getTime();
    if (dt !== 0) return dt;
    return a.lineId - b.lineId;
  });

  for (const line of orderedLines) {
    let best: { split: LedgerSplitInput; dist: number } | null = null;

    for (const split of ledgerSplits) {
      if (usedSplits.has(split.splitGuid)) continue;
      if (Math.abs(split.amountSigned - line.amountSigned) >= AMOUNT_EPSILON) continue;

      const dist = dayDistance(line.date, split.date);
      if (dist > windowDays) continue;

      if (best === null) {
        best = { split, dist };
        continue;
      }
      // Closest date wins; ties → earlier split date; then split guid asc.
      if (dist < best.dist) {
        best = { split, dist };
      } else if (dist === best.dist) {
        const dt = split.date.getTime() - best.split.date.getTime();
        if (dt < 0 || (dt === 0 && split.splitGuid < best.split.splitGuid)) {
          best = { split, dist };
        }
      }
    }

    if (best) {
      matched.push({ lineId: line.lineId, splitGuid: best.split.splitGuid });
      usedSplits.add(best.split.splitGuid);
      matchedLineIds.add(line.lineId);
    }
  }

  const missingOnStatement = lines
    .filter((l) => !matchedLineIds.has(l.lineId))
    .map((l) => l.lineId);

  const inLedgerNotOnStatement = ledgerSplits
    .filter((s) => !usedSplits.has(s.splitGuid))
    .map((s) => s.splitGuid);

  return { matched, missingOnStatement, inLedgerNotOnStatement };
}

/** Tolerance for declaring a reconcile "tied out". */
export const TIE_OUT_EPSILON = 0.005;

export interface TieOutInput {
  /** Statement opening balance, or null/undefined if the statement omits it. */
  openingBalance: number | null | undefined;
  /** Statement closing balance, or null/undefined if the statement omits it. */
  closingBalance: number | null | undefined;
  /** Sum of amounts (into-account convention) of splits being reconciled. */
  matchedSplitsAmount: number;
  /** Sum of amounts of statement lines that will be ADDED to the ledger. */
  addedLinesAmount: number;
}

export interface TieOutResult {
  /**
   * closingBalance - openingBalance, i.e. the balance change the statement
   * claims. null when either balance is unknown.
   */
  expectedChange: number | null;
  /**
   * The change we will actually reconcile: matched splits + to-be-added lines.
   * Always a number (0 when nothing selected).
   */
  actualChange: number;
  /** expectedChange - actualChange. null when expectedChange is unknown. */
  difference: number | null;
  /**
   * true  → reconciles cleanly (|difference| < TIE_OUT_EPSILON).
   * false → off by more than the tolerance.
   * null  → cannot be determined (opening/closing balance missing).
   */
  tiesOut: boolean | null;
}

/**
 * Reconcile tie-out.
 *
 * All figures are in the "positive = into account" convention. Over the
 * statement period the account balance must change by exactly the sum of every
 * transaction that touched it. The transactions we account for are:
 *   • matched splits   — already in the ledger, being marked reconciled
 *   • to-be-added lines — statement activity not yet in the ledger
 * so actualChange = matchedSplitsAmount + addedLinesAmount, and it must equal
 * expectedChange = closingBalance - openingBalance.
 *
 * If either statement balance is missing we cannot verify the tie-out, so
 * expectedChange/difference/tiesOut are null ("unknown").
 */
export function computeReconcileTieOut(input: TieOutInput): TieOutResult {
  const actualChange = input.matchedSplitsAmount + input.addedLinesAmount;

  const hasOpening = input.openingBalance !== null && input.openingBalance !== undefined;
  const hasClosing = input.closingBalance !== null && input.closingBalance !== undefined;

  if (!hasOpening || !hasClosing) {
    return {
      expectedChange: null,
      actualChange,
      difference: null,
      tiesOut: null,
    };
  }

  const expectedChange = (input.closingBalance as number) - (input.openingBalance as number);
  const difference = expectedChange - actualChange;
  const tiesOut = Math.abs(difference) < TIE_OUT_EPSILON;

  return { expectedChange, actualChange, difference, tiesOut };
}

/* ───────────────────────────── sign helpers ───────────────────────────── */

/**
 * Convert a GnuCash split's raw fraction value to the statement's signed
 * amount (positive = money INTO the account).
 *
 * This is simply the native decimal value: GnuCash's debit-positive raw sign
 * already matches the statement convention for every account type (see the
 * module header). No per-account-type negation is applied.
 */
export function splitValueToStatementAmount(
  valueNum: bigint | number | string,
  valueDenom: bigint | number | string,
): number {
  const num = Number(valueNum);
  const denom = Number(valueDenom);
  if (!denom) return 0;
  return num / denom;
}

/**
 * Convert a statement signed amount back into the GnuCash fraction to store on
 * the **statement-account** split of a newly-added transaction. Because of the
 * uniform convention this is a straight scale — a positive statement amount
 * yields a positive (debit) value_num, which correctly increases an asset
 * balance and correctly represents a credit-card payment.
 *
 * The counterpart split of the 2-split transaction gets the negated value
 * (see `negateSplitValue`) so the transaction sums to zero.
 */
export function statementAmountToSplitValue(
  amount: number,
  denom = 100,
): { num: bigint; denom: bigint } {
  return {
    num: BigInt(Math.round(amount * denom)),
    denom: BigInt(denom),
  };
}

/** Negate a {num, denom} value (for the balancing counterpart split). */
export function negateSplitValue(v: { num: bigint; denom: bigint }): { num: bigint; denom: bigint } {
  return { num: -v.num, denom: v.denom };
}
