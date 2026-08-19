/**
 * The project's numeric tolerances, in ONE place.
 *
 * Browser-safe: zero imports, pure constants and pure functions, so Client
 * Components can import it without dragging server-only code into the bundle.
 *
 * ── Which tolerance, when ────────────────────────────────────────────────────
 *
 * 1. VALIDATING THAT A LEDGER WRITE BALANCES — use NO tolerance at all.
 *    `assertBalanced()` in `src/lib/validation.ts` sums split values as exact
 *    BigInt rationals over a least-common denominator and requires exactly
 *    zero. Never re-express that check as a float comparison against an
 *    epsilon here: an epsilon-balanced write is an unbalanced book.
 *
 * 2. COMPARING TWO ALREADY-ROUNDED MONEY AMOUNTS (display, reporting,
 *    "is this effectively zero?", "did these two totals agree?") — use
 *    {@link MONEY_DISPLAY_EPSILON}, or {@link moneyEpsilonForScu} when the
 *    commodity's smallest unit is known and may be coarser or finer than a
 *    cent. Half the smallest unit is the largest difference that cannot
 *    survive rounding, so it is the correct "same number" bound. A whole cent
 *    is NOT: it silently accepts a real one-cent discrepancy as agreement.
 *
 * 3. COMPARING SHARE / QUANTITY COUNTS — use {@link qtyEpsilonForScu} with the
 *    account's `commodity_scu`. A flat 0.0001 is only right for coarse-scu
 *    stocks and funds; at crypto's 1e8 precision it reads a real one-unit
 *    oversell as agreement.
 *
 * 4. COMPARING A QUANTITY THAT ACCUMULATED FLOAT RESIDUE OVER A LONG REPLAY
 *    (running balances, pooled cost-basis coverage) — use
 *    {@link qtyEpsilonWithMagnitude}. An absolute epsilon does not scale: after
 *    100k splits, a 10-million-share balance carries more than 0.0001 of pure
 *    IEEE-754 residue, and an absolute bound flips a perfectly consistent
 *    position to "coverage unknown". The relative term handles the large end;
 *    the absolute floor still protects tiny positions.
 *
 * 5. NUMERICAL SOLVER CONVERGENCE — a solver's stopping criterion is not a
 *    money-equality test; it has its own named constant
 *    ({@link RATE_SOLVER_MONEY_TOLERANCE}) so tightening it cannot be confused
 *    with tightening a balance check.
 *
 * A lint-style tripwire test (`src/lib/__tests__/tolerance-literals.test.ts`)
 * fails when a NEW bare `0.005` / `0.01` / `0.0001` tolerance comparison
 * appears anywhere under `src/`, so the set below cannot quietly re-fragment.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Half a cent: the largest difference between two cent-rounded amounts that is
 * still the same amount.
 *
 * Use for float comparisons of money that has already been rounded to cents —
 * "is this balance zero?", "did the computed total match the reported one?",
 * "is this row worth showing?". Do NOT use it to validate that a ledger write
 * balances (see rule 1 above).
 */
export const MONEY_DISPLAY_EPSILON = 0.005;

/**
 * Half the smallest representable unit of a currency with `scu` units per
 * major unit (100 for USD/EUR, 1 for JPY, 1000 for a 3dp currency).
 *
 * Never LOOSER than {@link MONEY_DISPLAY_EPSILON} would be for that currency:
 * a coarse-scu currency such as JPY gets 0.5, a fine-scu one gets less than
 * half a cent. Falls back to {@link MONEY_DISPLAY_EPSILON} on a missing or
 * nonsensical scu.
 */
export function moneyEpsilonForScu(scu: number | bigint | null | undefined): number {
    const n = Number(scu);
    if (!Number.isFinite(n) || n <= 0) return MONEY_DISPLAY_EPSILON;
    return 0.5 / n;
}

/**
 * Convergence tolerance for the Newton-Raphson mortgage-rate solver, in
 * dollars of monthly payment.
 *
 * Deliberately a whole cent and deliberately NOT {@link MONEY_DISPLAY_EPSILON}:
 * this is a stopping criterion on a residual, not a claim that two amounts are
 * equal. A rate that reproduces the payment to the cent is exact for every
 * purpose the extracted rate is used for.
 */
export const RATE_SOLVER_MONEY_TOLERANCE = 0.01;

/**
 * Default fuzz when matching a computed sale against a broker 1099-B row by
 * proceeds. A whole cent, because brokers round intermediate commissions
 * differently than the book does; this is a MATCHING window, not an equality
 * test. Whether the matched rows then AGREE is judged at
 * {@link MONEY_DISPLAY_EPSILON}.
 */
export const BROKER_PROCEEDS_MATCH_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// Quantities (shares, units)
// ---------------------------------------------------------------------------

/** Legacy share epsilon, correct for stocks/funds at scu 100–10000. */
export const DEFAULT_QTY_EPSILON = 0.0001;

/**
 * Commodity-aware share epsilon derived from the commodity's fraction
 * (`commodity_scu`). At crypto's 1e8 precision, 0.0001 BTC is real money, so
 * the epsilon shrinks to half the smallest representable unit. It never grows
 * beyond the legacy 0.0001 so coarse-scu stocks keep their behavior.
 */
export function qtyEpsilonForScu(scu: number | bigint | null | undefined): number {
    const n = Number(scu);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_QTY_EPSILON;
    return Math.min(DEFAULT_QTY_EPSILON, 0.5 / n);
}

/**
 * Relative epsilon for quantities accumulated over a long replay.
 *
 * IEEE-754 doubles carry ~2.2e-16 of relative error per operation; 1e-9 leaves
 * roughly six orders of magnitude of headroom for the tens of thousands of
 * additions a large account's split replay performs, while staying far tighter
 * than any real share discrepancy a user could enter (the finest commodity_scu
 * GnuCash supports is 1e9, and a genuine one-unit disagreement there is 1e-9 of
 * a single share, not of a million-share balance).
 */
export const QTY_REL_EPSILON = 1e-9;

/**
 * Share epsilon that scales with the magnitude being compared.
 *
 * `max(qtyEpsilonForScu(scu), |magnitude| * QTY_REL_EPSILON)`. Use when the two
 * numbers being compared are running totals accumulated independently over the
 * same long sequence of splits (e.g. a share balance versus a cost-basis pool's
 * share count): the absolute floor keeps a 0.001-share position honest, and the
 * relative term keeps a 10-million-share position from being declared
 * inconsistent by float residue alone.
 *
 * CROSSOVER, stated plainly because it is the cost of the relative term: the
 * absolute floor governs until `|magnitude| > qtyEpsilonForScu(scu) /
 * QTY_REL_EPSILON` — 100,000 shares at scu 100, but only 5 units at crypto's
 * 1e8. Above that scale the tolerance grows with the position, so the smallest
 * disagreement this can still see grows with it too. That is the intended
 * trade: at those magnitudes an absolute 1e-8 bound was not measuring a real
 * disagreement anyway, only the replay's own arithmetic noise.
 *
 * @param scu       the commodity's `commodity_scu` (may be null/absent)
 * @param magnitude the scale of the comparison — pass the larger of the two
 *                  values, or their mean; only its absolute value is used
 */
export function qtyEpsilonWithMagnitude(
    scu: number | bigint | null | undefined,
    magnitude: number,
): number {
    const base = qtyEpsilonForScu(scu);
    const rel = Number.isFinite(magnitude) ? Math.abs(magnitude) * QTY_REL_EPSILON : 0;
    return Math.max(base, rel);
}
