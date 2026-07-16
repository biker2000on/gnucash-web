import { describe, it, expect } from 'vitest';
import { computeShoeboxSummary, type ShoeboxReceiptLike } from '@/lib/hsa-shoebox';

const r = (
  amount: number | null,
  hsaEligible = true,
  reimbursed = false,
): ShoeboxReceiptLike => ({ amount, hsaEligible, reimbursed });

describe('computeShoeboxSummary', () => {
  it('returns zeros for an empty receipt list', () => {
    const s = computeShoeboxSummary([], 0);
    expect(s).toEqual({
      eligibleCount: 0,
      unreimbursedCount: 0,
      reimbursedCount: 0,
      missingAmountCount: 0,
      totalEligibleUnreimbursed: 0,
      totalReimbursed: 0,
      hsaBalance: 0,
      headroom: 0,
    });
  });

  it('sums only eligible, unreimbursed receipts into the banked total', () => {
    const s = computeShoeboxSummary(
      [
        r(120.5),                 // eligible, unreimbursed
        r(80.25),                 // eligible, unreimbursed
        r(999, false),            // not eligible — ignored entirely
        r(50, true, true),        // eligible but already reimbursed
      ],
      10_000,
    );
    expect(s.eligibleCount).toBe(3);
    expect(s.unreimbursedCount).toBe(2);
    expect(s.reimbursedCount).toBe(1);
    expect(s.totalEligibleUnreimbursed).toBe(200.75);
    expect(s.totalReimbursed).toBe(50);
  });

  it('headroom is the smaller of unreimbursed total and HSA balance', () => {
    // Balance covers everything → headroom = unreimbursed total
    expect(computeShoeboxSummary([r(300), r(200)], 5_000).headroom).toBe(500);
    // Receipts exceed balance → headroom = balance
    expect(computeShoeboxSummary([r(3_000), r(2_000)], 1_234.56).headroom).toBe(1_234.56);
    // Exactly equal
    expect(computeShoeboxSummary([r(500)], 500).headroom).toBe(500);
  });

  it('counts missing amounts without contributing to totals', () => {
    const s = computeShoeboxSummary([r(null), r(100)], 1_000);
    expect(s.unreimbursedCount).toBe(2);
    expect(s.missingAmountCount).toBe(1);
    expect(s.totalEligibleUnreimbursed).toBe(100);
  });

  it('ignores negative and non-finite amounts', () => {
    const s = computeShoeboxSummary([r(-50), r(NaN), r(100)], 1_000);
    expect(s.totalEligibleUnreimbursed).toBe(100);
    expect(s.missingAmountCount).toBe(2);
  });

  it('clamps a negative HSA balance to zero (headroom cannot go negative)', () => {
    const s = computeShoeboxSummary([r(100)], -250);
    expect(s.hsaBalance).toBe(0);
    expect(s.headroom).toBe(0);
  });

  it('avoids floating point drift by summing in cents', () => {
    const s = computeShoeboxSummary([r(0.1), r(0.2)], 100);
    expect(s.totalEligibleUnreimbursed).toBe(0.3);
  });
});
