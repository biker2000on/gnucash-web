/**
 * OBBBA individual provisions (P.L. 119-21):
 *   §224 tips deduction, §225 overtime deduction, §163(h)(4) car-loan
 *   interest (all 2025-2028), and the 2026+ charitable rules (§170(p)/(q))
 *   plus the §68 2/37 itemized limitation.
 *
 * Parameters verified against the statutes, IRS Notice 2025-69, and the
 * 2025 Schedule 1-A: tips/overtime phase out $100 per FULL $1,000 of
 * excess MAGI (quotient rounded DOWN); car-loan interest phases out $200
 * per $1,000 "or portion thereof" (rounded UP); the tips and car-loan caps
 * are per return (never doubled for joint filers).
 */

import { describe, it, expect } from 'vitest';
import {
  computeFederalTax,
  computeTipsDeduction,
  computeOvertimeDeduction,
  computeCarLoanInterestDeduction,
  emptyFederalInputs,
} from '@/lib/tax/federal';
import type { FederalTaxInputs } from '@/lib/tax/types';

function inputs(overrides: Partial<FederalTaxInputs>): FederalTaxInputs {
  return { ...emptyFederalInputs(2025, 'single'), ...overrides };
}

/* ------------------------------------------------------------------ */
/* §224 tips deduction                                                 */
/* ------------------------------------------------------------------ */

describe('§224 tips deduction (2025-2028)', () => {
  it('is year-gated: 0 in 2024, live in 2025', () => {
    expect(computeTipsDeduction(10_000, 50_000, 'single', 2024)).toBe(0);
    expect(computeTipsDeduction(10_000, 50_000, 'single', 2025)).toBe(10_000);
    expect(computeTipsDeduction(10_000, 50_000, 'single', 2026)).toBe(10_000);
  });

  it('caps at $25,000 per return — joint filers do NOT get double', () => {
    expect(computeTipsDeduction(30_000, 50_000, 'single', 2025)).toBe(25_000);
    expect(computeTipsDeduction(60_000, 50_000, 'mfj', 2025)).toBe(25_000);
  });

  it('phases out $100 per FULL $1,000 over $150,000 (quotient rounded down)', () => {
    // $999 of excess is less than a full $1,000 — no reduction yet.
    expect(computeTipsDeduction(25_000, 150_999, 'single', 2025)).toBe(25_000);
    expect(computeTipsDeduction(25_000, 151_000, 'single', 2025)).toBe(24_900);
    // floor(10,500 / 1,000) = 10 → $1,000 reduction
    expect(computeTipsDeduction(25_000, 160_500, 'single', 2025)).toBe(24_000);
    // Fully phased out at $400,000 (excess 250k → $25,000 reduction)
    expect(computeTipsDeduction(25_000, 400_000, 'single', 2025)).toBe(0);
  });

  it('uses the $300,000 threshold for a joint return', () => {
    expect(computeTipsDeduction(25_000, 299_000, 'mfj', 2025)).toBe(25_000);
    expect(computeTipsDeduction(25_000, 301_000, 'mfj', 2025)).toBe(24_900);
  });

  it('QSS is not a joint return — single-filer threshold applies', () => {
    // excess 150,000 → $15,000 reduction
    expect(computeTipsDeduction(25_000, 300_000, 'qss', 2025)).toBe(10_000);
  });

  it('is disallowed entirely for married filing separately (§224(f))', () => {
    expect(computeTipsDeduction(10_000, 50_000, 'mfs', 2025)).toBe(0);
  });

  it('flows through the engine below the line (does not reduce AGI)', () => {
    const r = computeFederalTax(inputs({ wages: 100_000, qualifiedTipIncome: 8_000 }));
    expect(r.agi).toBe(100_000);
    expect(r.tipsDeduction).toBe(8_000);
    // 100,000 − 15,750 std − 8,000 tips
    expect(r.taxableIncome).toBe(76_250);
  });

  it('does nothing in the engine for 2024', () => {
    const r = computeFederalTax(inputs({ year: 2024, wages: 100_000, qualifiedTipIncome: 8_000 }));
    expect(r.tipsDeduction).toBe(0);
    expect(r.taxableIncome).toBe(100_000 - 14_600);
  });
});

/* ------------------------------------------------------------------ */
/* §225 overtime deduction                                             */
/* ------------------------------------------------------------------ */

describe('§225 overtime deduction (2025-2028)', () => {
  it('is year-gated: 0 in 2024', () => {
    expect(computeOvertimeDeduction(5_000, 50_000, 'single', 2024)).toBe(0);
    expect(computeOvertimeDeduction(5_000, 50_000, 'single', 2025)).toBe(5_000);
  });

  it('caps at $12,500 single / $25,000 joint', () => {
    expect(computeOvertimeDeduction(20_000, 50_000, 'single', 2025)).toBe(12_500);
    expect(computeOvertimeDeduction(30_000, 50_000, 'mfj', 2025)).toBe(25_000);
    // QSS is not a joint return — single-filer cap
    expect(computeOvertimeDeduction(30_000, 50_000, 'qss', 2025)).toBe(12_500);
  });

  it('shares the tips phase-out: $100 per full $1,000 over $150k/$300k', () => {
    expect(computeOvertimeDeduction(12_500, 150_999, 'single', 2025)).toBe(12_500);
    expect(computeOvertimeDeduction(12_500, 151_000, 'single', 2025)).toBe(12_400);
    // excess 50,000 → $5,000 reduction
    expect(computeOvertimeDeduction(12_500, 200_000, 'single', 2025)).toBe(7_500);
    expect(computeOvertimeDeduction(25_000, 301_000, 'mfj', 2025)).toBe(24_900);
  });

  it('is disallowed for married filing separately (§225(e))', () => {
    expect(computeOvertimeDeduction(5_000, 50_000, 'mfs', 2025)).toBe(0);
  });

  it('flows through the engine and stacks with tips', () => {
    const r = computeFederalTax(inputs({
      wages: 100_000,
      qualifiedTipIncome: 5_000,
      qualifiedOvertimeCompensation: 4_000,
    }));
    expect(r.tipsDeduction).toBe(5_000);
    expect(r.overtimeDeduction).toBe(4_000);
    expect(r.taxableIncome).toBe(100_000 - 15_750 - 5_000 - 4_000);
  });
});

/* ------------------------------------------------------------------ */
/* §163(h)(4) car-loan interest deduction                              */
/* ------------------------------------------------------------------ */

describe('§163(h)(4) car-loan interest deduction (2025-2028)', () => {
  it('is year-gated: 0 in 2024', () => {
    expect(computeCarLoanInterestDeduction(3_000, 50_000, 'single', 2024)).toBe(0);
    expect(computeCarLoanInterestDeduction(3_000, 50_000, 'single', 2025)).toBe(3_000);
  });

  it('caps at $10,000 per return regardless of filing status', () => {
    expect(computeCarLoanInterestDeduction(12_000, 50_000, 'single', 2025)).toBe(10_000);
    expect(computeCarLoanInterestDeduction(12_000, 50_000, 'mfj', 2025)).toBe(10_000);
  });

  it('phases out $200 per $1,000 OR PORTION THEREOF over $100,000 (rounded up)', () => {
    expect(computeCarLoanInterestDeduction(10_000, 100_000, 'single', 2025)).toBe(10_000);
    // $1 of excess is a "portion" of the first $1,000 → full $200 reduction
    expect(computeCarLoanInterestDeduction(10_000, 100_001, 'single', 2025)).toBe(9_800);
    // ceil(500 / 1,000) = 1 on the joint threshold
    expect(computeCarLoanInterestDeduction(10_000, 200_500, 'mfj', 2025)).toBe(9_800);
    // Fully phased out at $150,000 single (excess 50k → $10,000 reduction)
    expect(computeCarLoanInterestDeduction(10_000, 150_000, 'single', 2025)).toBe(0);
  });

  it('allows MFS (no joint-return requirement) at the $100,000 threshold', () => {
    // excess 20,000 → $4,000 reduction
    expect(computeCarLoanInterestDeduction(5_000, 120_000, 'mfs', 2025)).toBe(1_000);
  });

  it('flows through the engine below the line', () => {
    const r = computeFederalTax(inputs({ wages: 90_000, qualifiedCarLoanInterest: 1_500 }));
    expect(r.agi).toBe(90_000);
    expect(r.carLoanInterestDeduction).toBe(1_500);
    expect(r.taxableIncome).toBe(90_000 - 15_750 - 1_500);
  });
});

/* ------------------------------------------------------------------ */
/* §170(q) charitable floor for itemizers (2026+)                      */
/* ------------------------------------------------------------------ */

describe('§170(q) 0.5% AGI charitable floor for itemizers (2026+)', () => {
  const itemizer = (year: 2025 | 2026) => inputs({
    year,
    wages: 200_000,
    charitableDonations: 20_000,
    mortgageInterest: 15_000,
  });

  it('2026: disallows the first 0.5% of AGI when itemizing', () => {
    const r = computeFederalTax(itemizer(2026));
    expect(r.usedItemized).toBe(true);
    expect(r.itemizedBreakdown.charitableFloorDisallowed).toBe(1_000); // 0.5% × 200k
    expect(r.itemizedBreakdown.charitable).toBe(19_000);
    expect(r.itemizedDeduction).toBe(34_000);
  });

  it('2025: no floor', () => {
    const r = computeFederalTax(itemizer(2025));
    expect(r.itemizedBreakdown.charitableFloorDisallowed).toBe(0);
    expect(r.itemizedBreakdown.charitable).toBe(20_000);
    expect(r.itemizedDeduction).toBe(35_000);
  });

  it('floor never exceeds the gifts themselves', () => {
    const r = computeFederalTax(inputs({
      year: 2026, wages: 400_000, charitableDonations: 500, mortgageInterest: 30_000,
    }));
    // 0.5% × 400k = 2,000 > 500 gift → entire gift floored, not negative
    expect(r.itemizedBreakdown.charitableFloorDisallowed).toBe(500);
    expect(r.itemizedBreakdown.charitable).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* §170(p) non-itemizer charitable deduction (2026+)                   */
/* ------------------------------------------------------------------ */

describe('§170(p) non-itemizer charitable deduction (2026+)', () => {
  it('2026 single standard-deduction filer: up to $1,000', () => {
    const r = computeFederalTax(inputs({ year: 2026, wages: 100_000, charitableDonations: 3_000 }));
    expect(r.usedItemized).toBe(false);
    expect(r.nonItemizerCharitableDeduction).toBe(1_000);
    // No floor applies to the non-itemizer deduction
    expect(r.taxableIncome).toBe(100_000 - 16_100 - 1_000);
  });

  it('smaller gifts deduct in full', () => {
    const r = computeFederalTax(inputs({ year: 2026, wages: 100_000, charitableDonations: 400 }));
    expect(r.nonItemizerCharitableDeduction).toBe(400);
  });

  it('joint returns get $2,000; QSS gets the single amount', () => {
    const mfj = computeFederalTax(inputs({
      year: 2026, filingStatus: 'mfj', wages: 150_000, charitableDonations: 5_000,
    }));
    expect(mfj.nonItemizerCharitableDeduction).toBe(2_000);
    const qss = computeFederalTax(inputs({
      year: 2026, filingStatus: 'qss', wages: 150_000, charitableDonations: 5_000,
    }));
    expect(qss.nonItemizerCharitableDeduction).toBe(1_000);
  });

  it('not available before 2026', () => {
    const r = computeFederalTax(inputs({ year: 2025, wages: 100_000, charitableDonations: 3_000 }));
    expect(r.nonItemizerCharitableDeduction).toBe(0);
  });

  it('not available when itemizing (floor applies instead)', () => {
    const r = computeFederalTax(inputs({
      year: 2026, wages: 200_000, charitableDonations: 20_000, mortgageInterest: 15_000,
    }));
    expect(r.usedItemized).toBe(true);
    expect(r.nonItemizerCharitableDeduction).toBe(0);
    expect(r.itemizedBreakdown.charitableFloorDisallowed).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* §68 2/37 overall itemized limitation (2026+)                        */
/* ------------------------------------------------------------------ */

describe('§68 2/37 itemized limitation (2026+, 37% bracket)', () => {
  it('reduces itemized deductions by 2/37 when itemized is the lesser', () => {
    // 2026 single: 37% bracket starts at 640,600.
    const r = computeFederalTax(inputs({
      year: 2026, wages: 1_000_000, mortgageInterest: 50_000,
    }));
    expect(r.usedItemized).toBe(true);
    // taxable without §68 = 950,000; +50,000 itemized = 1,000,000 > 640,600,
    // so the lesser is the 50,000 of itemized deductions.
    expect(r.itemizedLimitationReduction).toBeCloseTo((2 / 37) * 50_000, 2);
    expect(r.deductionTaken).toBeCloseTo(50_000 - (2 / 37) * 50_000, 2);
    expect(r.itemizedDeduction).toBe(50_000); // reported pre-limitation
  });

  it('uses the excess-over-bracket measure when that is the lesser', () => {
    // taxable without §68 = 655,000 − 50,000 = 605,000;
    // measure = 605,000 + 50,000 − 640,600 = 14,400 < 50,000.
    const r = computeFederalTax(inputs({
      year: 2026, wages: 655_000, mortgageInterest: 50_000,
    }));
    expect(r.itemizedLimitationReduction).toBeCloseTo((2 / 37) * 14_400, 2);
  });

  it('no reduction below the 37% bracket', () => {
    const r = computeFederalTax(inputs({
      year: 2026, wages: 300_000, mortgageInterest: 40_000,
    }));
    expect(r.usedItemized).toBe(true);
    expect(r.itemizedLimitationReduction).toBe(0);
    expect(r.deductionTaken).toBe(40_000);
  });

  it('does not apply before 2026', () => {
    const r = computeFederalTax(inputs({
      year: 2025, wages: 1_000_000, mortgageInterest: 50_000,
    }));
    expect(r.itemizedLimitationReduction).toBe(0);
    expect(r.deductionTaken).toBe(50_000);
  });

  it('does not apply to standard-deduction filers', () => {
    const r = computeFederalTax(inputs({ year: 2026, wages: 1_000_000 }));
    expect(r.usedItemized).toBe(false);
    expect(r.itemizedLimitationReduction).toBe(0);
  });

  it('uses the MFJ 37% bracket start ($768,700) for joint returns', () => {
    const below = computeFederalTax(inputs({
      year: 2026, filingStatus: 'mfj', wages: 700_000, mortgageInterest: 50_000,
    }));
    expect(below.itemizedLimitationReduction).toBe(0);
    const above = computeFederalTax(inputs({
      year: 2026, filingStatus: 'mfj', wages: 1_200_000, mortgageInterest: 50_000,
    }));
    expect(above.itemizedLimitationReduction).toBeCloseTo((2 / 37) * 50_000, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

describe('OBBBA provision interactions', () => {
  it('tips/overtime/car-loan stack with the senior deduction before QBI', () => {
    const r = computeFederalTax(inputs({
      year: 2025,
      wages: 80_000,
      filersAge65Plus: 1,
      qualifiedTipIncome: 5_000,
      qualifiedOvertimeCompensation: 2_000,
      qualifiedCarLoanInterest: 1_000,
    }));
    // std 15,750 + age-65 2,000; senior 6,000 − 6% × (80,000 − 75,000) = 5,700
    expect(r.seniorDeduction).toBeCloseTo(5_700, 2);
    expect(r.taxableIncome).toBeCloseTo(
      80_000 - (15_750 + 2_000) - 5_700 - 5_000 - 2_000 - 1_000, 2,
    );
  });

  it('phase-outs key off AGI (MAGI), not wages', () => {
    // 401k contributions lower AGI below the tips phase-out start.
    const r = computeFederalTax(inputs({
      wages: 155_000,
      traditional401kContributions: 10_000,
      qualifiedTipIncome: 25_000,
    }));
    expect(r.agi).toBe(145_000);
    expect(r.tipsDeduction).toBe(25_000); // no reduction below 150k MAGI
  });

  it('MFS keeps car-loan interest while losing tips and overtime', () => {
    const r = computeFederalTax(inputs({
      filingStatus: 'mfs',
      wages: 90_000,
      qualifiedTipIncome: 5_000,
      qualifiedOvertimeCompensation: 3_000,
      qualifiedCarLoanInterest: 2_000,
    }));
    expect(r.tipsDeduction).toBe(0);
    expect(r.overtimeDeduction).toBe(0);
    expect(r.carLoanInterestDeduction).toBe(2_000);
  });
});
