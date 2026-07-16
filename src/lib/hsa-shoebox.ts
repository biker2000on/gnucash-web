/**
 * HSA Shoebox — pure summary math, no I/O.
 *
 * The "shoebox" strategy: pay qualified medical expenses out of pocket,
 * keep the receipts, let the HSA stay invested, and reimburse yourself
 * tax-free years later. The summary tracks how much tax-free money is
 * "banked" in receipts and how much of it the current HSA balance could
 * actually cover today.
 */

/** Minimal receipt shape the summary needs. */
export interface ShoeboxReceiptLike {
  /** Extracted dollar amount; null when OCR/extraction found none. */
  amount: number | null;
  /** User marked this receipt as HSA-qualified. */
  hsaEligible: boolean;
  /** Already reimbursed (stamped with a reimbursement transaction). */
  reimbursed: boolean;
}

export interface ShoeboxSummary {
  /** Count of receipts marked HSA-eligible (reimbursed or not). */
  eligibleCount: number;
  /** Eligible receipts not yet reimbursed. */
  unreimbursedCount: number;
  /** Eligible receipts already reimbursed. */
  reimbursedCount: number;
  /** Eligible + unreimbursed receipts that have no extracted amount. */
  missingAmountCount: number;
  /** Sum of eligible, unreimbursed receipt amounts (the banked total). */
  totalEligibleUnreimbursed: number;
  /** Sum of eligible receipt amounts already reimbursed. */
  totalReimbursed: number;
  /** Current HSA balance passed in by the caller. */
  hsaBalance: number;
  /** min(unreimbursed total, HSA balance) — what you could withdraw tax-free today. */
  headroom: number;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Compute the shoebox summary from a receipt list and the current HSA
 * balance. Sums in integer cents to avoid floating-point drift. Receipts
 * without an extracted amount count toward `missingAmountCount` but
 * contribute $0 to totals. Negative amounts are ignored (a receipt cannot
 * bank negative headroom).
 */
export function computeShoeboxSummary(
  receipts: ShoeboxReceiptLike[],
  hsaBalance: number,
): ShoeboxSummary {
  let eligibleCount = 0;
  let unreimbursedCount = 0;
  let reimbursedCount = 0;
  let missingAmountCount = 0;
  let unreimbursedCents = 0;
  let reimbursedCents = 0;

  for (const r of receipts) {
    if (!r.hsaEligible) continue;
    eligibleCount++;
    const amountCents =
      r.amount !== null && Number.isFinite(r.amount) && r.amount > 0 ? cents(r.amount) : null;
    if (r.reimbursed) {
      reimbursedCount++;
      if (amountCents !== null) reimbursedCents += amountCents;
    } else {
      unreimbursedCount++;
      if (amountCents === null) missingAmountCount++;
      else unreimbursedCents += amountCents;
    }
  }

  const totalEligibleUnreimbursed = unreimbursedCents / 100;
  const balance = Number.isFinite(hsaBalance) ? Math.max(0, hsaBalance) : 0;

  return {
    eligibleCount,
    unreimbursedCount,
    reimbursedCount,
    missingAmountCount,
    totalEligibleUnreimbursed,
    totalReimbursed: reimbursedCents / 100,
    hsaBalance: Math.round(balance * 100) / 100,
    headroom: Math.min(totalEligibleUnreimbursed, Math.round(balance * 100) / 100),
  };
}
