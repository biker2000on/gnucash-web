import { describe, it, expect } from 'vitest';
import {
  computeIraDeductionLimit,
  computeRothIraContributionLimit,
  IRA_DEDUCTION_PHASEOUT,
  IRA_SPOUSE_COVERED_PHASEOUT,
  ROTH_IRA_PHASEOUT,
} from '@/lib/tax/phaseouts';
import { computeFederalTax, emptyFederalInputs } from '@/lib/tax/federal';
import type { FederalTaxInputs, TaxYear } from '@/lib/tax/types';

describe('traditional IRA deduction phase-out (covered by employer plan)', () => {
  const base = {
    coveredByEmployerPlan: true,
    spouseCoveredByEmployerPlan: false,
    iraLimit: 7_000,
  };

  it('below phase-out start → full deduction (2025 single)', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 70_000 });
    expect(r).toEqual({ deductibleLimit: 7_000, phaseOutStart: 79_000, phaseOutEnd: 89_000, status: 'full' });
  });

  it('exactly at phase-out start → still full', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 79_000 });
    expect(r.status).toBe('full');
    expect(r.deductibleLimit).toBe(7_000);
  });

  it('midpoint of range → half the limit (2025 single, $84,000 MAGI)', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 84_000 });
    // 7000 × (89,000 − 84,000) / 10,000 = 3,500 (already a multiple of $10)
    expect(r.status).toBe('partial');
    expect(r.deductibleLimit).toBe(3_500);
  });

  it('non-round result rounds UP to the nearest $10', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 84_321 });
    // 7000 × 4,679 / 10,000 = 3,275.30 → rounds up to 3,280
    expect(r.deductibleLimit).toBe(3_280);
  });

  it('applies the $200 minimum near the top of the range', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 88_900 });
    // 7000 × 100 / 10,000 = 70 → floored up to $200 (Pub 590-A)
    expect(r.status).toBe('partial');
    expect(r.deductibleLimit).toBe(200);
  });

  it('at or above phase-out end → nothing deductible', () => {
    const atEnd = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 89_000 });
    expect(atEnd).toMatchObject({ deductibleLimit: 0, status: 'none' });
    const above = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'single', magi: 250_000 });
    expect(above.deductibleLimit).toBe(0);
  });

  it('hoh follows the single ranges', () => {
    const single = computeIraDeductionLimit({ ...base, year: 2026, filingStatus: 'single', magi: 86_000 });
    const hoh = computeIraDeductionLimit({ ...base, year: 2026, filingStatus: 'hoh', magi: 86_000 });
    expect(hoh).toEqual(single);
    expect(hoh.phaseOutStart).toBe(81_000);
    expect(hoh.phaseOutEnd).toBe(91_000);
  });

  it('mfj uses its own range (2024: 123,000–143,000)', () => {
    const r = computeIraDeductionLimit({ ...base, year: 2024, filingStatus: 'mfj', magi: 133_000 });
    expect(r.phaseOutStart).toBe(123_000);
    expect(r.phaseOutEnd).toBe(143_000);
    expect(r.deductibleLimit).toBe(3_500); // midpoint
  });

  it('mfs phases out over 0–10,000', () => {
    const zero = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'mfs', magi: 0 });
    expect(zero.status).toBe('full');
    const mid = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'mfs', magi: 5_000 });
    expect(mid.deductibleLimit).toBe(3_500);
    const end = computeIraDeductionLimit({ ...base, year: 2025, filingStatus: 'mfs', magi: 10_000 });
    expect(end.deductibleLimit).toBe(0);
    expect(end.status).toBe('none');
  });
});

describe('traditional IRA deduction — spouse-covered and not-covered cases', () => {
  it('not covered, spouse not covered → fully deductible at any MAGI', () => {
    const r = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfj', magi: 1_000_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: false, iraLimit: 7_000,
    });
    expect(r).toEqual({ deductibleLimit: 7_000, phaseOutStart: null, phaseOutEnd: null, status: 'full' });
  });

  it('spouse-covered MFJ uses the higher 236,000–246,000 range (2025)', () => {
    const full = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfj', magi: 200_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: true, iraLimit: 7_000,
    });
    expect(full.status).toBe('full');
    expect(full.phaseOutStart).toBe(236_000);
    expect(full.phaseOutEnd).toBe(246_000);

    const partial = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfj', magi: 241_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: true, iraLimit: 7_000,
    });
    expect(partial.deductibleLimit).toBe(3_500);

    const none = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfj', magi: 246_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: true, iraLimit: 7_000,
    });
    expect(none.deductibleLimit).toBe(0);
  });

  it('spouse-covered MFS uses the 0–10,000 range', () => {
    const r = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfs', magi: 5_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: true, iraLimit: 7_000,
    });
    expect(r.deductibleLimit).toBe(3_500);
    expect(r.phaseOutEnd).toBe(10_000);
  });

  it('contributor coverage takes precedence over spouse coverage', () => {
    const r = computeIraDeductionLimit({
      year: 2025, filingStatus: 'mfj', magi: 136_000,
      coveredByEmployerPlan: true, spouseCoveredByEmployerPlan: true, iraLimit: 7_000,
    });
    expect(r.phaseOutStart).toBe(126_000); // covered-participant range, not 236k
    expect(r.deductibleLimit).toBe(3_500);
  });

  it('2026 spouse-covered range is 242,000–252,000', () => {
    const r = computeIraDeductionLimit({
      year: 2026, filingStatus: 'mfj', magi: 247_000,
      coveredByEmployerPlan: false, spouseCoveredByEmployerPlan: true, iraLimit: 7_500,
    });
    expect(r.deductibleLimit).toBe(3_750);
  });
});

describe('Roth IRA contribution phase-out', () => {
  it('below start → full contribution (2025 single)', () => {
    const r = computeRothIraContributionLimit({ year: 2025, filingStatus: 'single', magi: 150_000, iraLimit: 7_000 });
    expect(r).toEqual({ deductibleLimit: 7_000, phaseOutStart: 150_000, phaseOutEnd: 165_000, status: 'full' });
  });

  it('midpoint → half the limit (2025 single, $157,500)', () => {
    const r = computeRothIraContributionLimit({ year: 2025, filingStatus: 'single', magi: 157_500, iraLimit: 7_000 });
    expect(r.status).toBe('partial');
    expect(r.deductibleLimit).toBe(3_500);
  });

  it('rounds up to the nearest $10 ($160,000 → $2,340)', () => {
    const r = computeRothIraContributionLimit({ year: 2025, filingStatus: 'single', magi: 160_000, iraLimit: 7_000 });
    // 7000 × 5,000 / 15,000 = 2,333.33 → 2,340
    expect(r.deductibleLimit).toBe(2_340);
  });

  it('applies the $200 minimum near the top of the range', () => {
    const r = computeRothIraContributionLimit({ year: 2025, filingStatus: 'single', magi: 164_900, iraLimit: 7_000 });
    // 7000 × 100 / 15,000 = 46.67 → $200 minimum
    expect(r.deductibleLimit).toBe(200);
  });

  it('at or above end → no Roth contribution allowed', () => {
    const r = computeRothIraContributionLimit({ year: 2025, filingStatus: 'single', magi: 165_000, iraLimit: 7_000 });
    expect(r).toMatchObject({ deductibleLimit: 0, status: 'none' });
  });

  it('mfs phases out over 0–10,000', () => {
    const mid = computeRothIraContributionLimit({ year: 2024, filingStatus: 'mfs', magi: 5_000, iraLimit: 7_000 });
    expect(mid.deductibleLimit).toBe(3_500);
    const end = computeRothIraContributionLimit({ year: 2024, filingStatus: 'mfs', magi: 10_000, iraLimit: 7_000 });
    expect(end.deductibleLimit).toBe(0);
  });

  it('qss follows the mfj ranges', () => {
    const mfj = computeRothIraContributionLimit({ year: 2025, filingStatus: 'mfj', magi: 240_000, iraLimit: 7_000 });
    const qss = computeRothIraContributionLimit({ year: 2025, filingStatus: 'qss', magi: 240_000, iraLimit: 7_000 });
    expect(qss).toEqual(mfj);
    // 7000 × 6,000 / 10,000 = 4,200
    expect(qss.deductibleLimit).toBe(4_200);
  });

  it('2026 mfj range is 242,000–252,000 with the $7,500 limit', () => {
    const r = computeRothIraContributionLimit({ year: 2026, filingStatus: 'mfj', magi: 247_000, iraLimit: 7_500 });
    expect(r.phaseOutStart).toBe(242_000);
    expect(r.phaseOutEnd).toBe(252_000);
    expect(r.deductibleLimit).toBe(3_750);
  });
});

describe('schedule tables (exported for the UI)', () => {
  it('cover every supported year', () => {
    for (const year of [2024, 2025, 2026] as TaxYear[]) {
      expect(IRA_DEDUCTION_PHASEOUT[year]).toBeDefined();
      expect(IRA_SPOUSE_COVERED_PHASEOUT[year]).toBeDefined();
      expect(ROTH_IRA_PHASEOUT[year]).toBeDefined();
    }
  });

  it('2024 values match Notice 2023-75', () => {
    expect(IRA_DEDUCTION_PHASEOUT[2024].single).toEqual({ start: 77_000, end: 87_000 });
    expect(IRA_DEDUCTION_PHASEOUT[2024].mfj).toEqual({ start: 123_000, end: 143_000 });
    expect(IRA_SPOUSE_COVERED_PHASEOUT[2024]).toEqual({ start: 230_000, end: 240_000 });
    expect(ROTH_IRA_PHASEOUT[2024].single).toEqual({ start: 146_000, end: 161_000 });
    expect(ROTH_IRA_PHASEOUT[2024].mfj).toEqual({ start: 230_000, end: 240_000 });
  });

  it('2026 values match Notice 2025-67', () => {
    expect(IRA_DEDUCTION_PHASEOUT[2026].single).toEqual({ start: 81_000, end: 91_000 });
    expect(IRA_DEDUCTION_PHASEOUT[2026].mfj).toEqual({ start: 129_000, end: 149_000 });
    expect(ROTH_IRA_PHASEOUT[2026].single).toEqual({ start: 153_000, end: 168_000 });
    expect(ROTH_IRA_PHASEOUT[2026].mfj).toEqual({ start: 242_000, end: 252_000 });
  });
});

describe('federal engine — SEP/SIMPLE above-the-line adjustments', () => {
  function inputs(overrides: Partial<FederalTaxInputs>): FederalTaxInputs {
    return { ...emptyFederalInputs(2025, 'single'), ...overrides };
  }

  it('sepIraContributions reduce AGI', () => {
    const without = computeFederalTax(inputs({ wages: 150_000 }));
    const withSep = computeFederalTax(inputs({ wages: 150_000, sepIraContributions: 10_000 }));
    expect(withSep.agi).toBe(without.agi - 10_000);
    expect(withSep.adjustments).toBe(10_000);
    expect(withSep.totalTax).toBeLessThan(without.totalTax);
  });

  it('simpleIraContributions reduce AGI', () => {
    const without = computeFederalTax(inputs({ wages: 100_000 }));
    const withSimple = computeFederalTax(inputs({ wages: 100_000, simpleIraContributions: 16_500 }));
    expect(withSimple.agi).toBe(without.agi - 16_500);
  });

  it('undefined SEP/SIMPLE fields default to 0', () => {
    const base = inputs({ wages: 80_000 });
    delete base.sepIraContributions;
    delete base.simpleIraContributions;
    const r = computeFederalTax(base);
    expect(r.adjustments).toBe(0);
    expect(r.agi).toBe(80_000);
  });

  it('negative SEP/SIMPLE values are clamped to 0', () => {
    const r = computeFederalTax(inputs({ wages: 80_000, sepIraContributions: -5_000, simpleIraContributions: -1 }));
    expect(r.adjustments).toBe(0);
  });
});
