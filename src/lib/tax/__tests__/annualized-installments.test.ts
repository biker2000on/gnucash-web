/**
 * Form 2210 Schedule AI annualized-installment engine — pure column math.
 *
 * Reference: 2210 Schedule AI lines 21-27. Applicable percentages 22.5% /
 * 45% / 67.5% / 90%; annualization factors 4 / 2.4 / 1.5 / 1 for periods
 * ending Mar 31 / May 31 / Aug 31 / Dec 31.
 */

import { describe, expect, it } from 'vitest';
import {
  ANNUALIZATION_FACTORS,
  APPLICABLE_PERCENTAGES,
  computeAnnualizedInstallments,
} from '../annualized-installments';

describe('computeAnnualizedInstallments', () => {
  it('pins the statutory constants', () => {
    expect(ANNUALIZATION_FACTORS).toEqual([4, 2.4, 1.5, 1]);
    expect(APPLICABLE_PERCENTAGES).toEqual([0.225, 0.45, 0.675, 0.9]);
  });

  it('matches the regular schedule when income is perfectly even', () => {
    // Even income annualizes to the same full-year tax in every column.
    // 90% of that tax equals the required annual payment here, so each
    // column's annualized installment lands exactly on the regular 25%.
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 9_000,
      annualizedTaxByColumn: [10_000, 10_000, 10_000, 10_000],
    });
    expect(result.applicable).toBe(true);
    expect(result.anyBenefit).toBe(false);
    expect(result.requiredCumulativeByQuarter).toEqual([2_250, 4_500, 6_750, 9_000]);
    expect(result.columns.every(c => c.methodUsed === 'regular')).toBe(true);
  });

  it('relieves early quarters for Q4-concentrated income and recaptures later', () => {
    // Hand-computed through the form's line flow (regular installment 2000):
    //   col1: line21 = 4000x.225 = 900;  line26 = 2000;        line27 = 900
    //   col2: line21 = 4000x.45  = 1800; line22 = 900;  line23 = 900
    //         line25 = 1100; line26 = 3100;                    line27 = 900
    //   col3: line21 = 4000x.675 = 2700; line22 = 1800; line23 = 900
    //         line25 = 2200; line26 = 4200;                    line27 = 900
    //   col4: line21 = 10000x.9  = 9000; line22 = 2700; line23 = 6300
    //         line25 = 3300; line26 = 5300; min(6300, 5300) -> line27 = 5300
    // Total = 900x3 + 5300 = 8000 = the required annual payment.
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 8_000,
      annualizedTaxByColumn: [4_000, 4_000, 4_000, 10_000],
    });
    expect(result.anyBenefit).toBe(true);
    expect(result.columns.map(c => c.chosenInstallment)).toEqual([900, 900, 900, 5_300]);
    expect(result.columns.map(c => c.methodUsed)).toEqual([
      'annualized', 'annualized', 'annualized', 'regular',
    ]);
    expect(result.columns.map(c => c.recaptureFromPrior)).toEqual([0, 1_100, 2_200, 3_300]);
    expect(result.requiredCumulativeByQuarter).toEqual([900, 1_800, 2_700, 8_000]);
  });

  it('never requires more than the required annual payment in total', () => {
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 8_000,
      // Annualized tax spikes early — AI columns exceed regular ones.
      annualizedTaxByColumn: [40_000, 30_000, 20_000, 10_000],
    });
    // Every column caps at the regular schedule (line 27 = min).
    expect(result.anyBenefit).toBe(false);
    expect(result.requiredCumulativeByQuarter).toEqual([2_000, 4_000, 6_000, 8_000]);
  });

  it('can require LESS than the annual payment when 90% of actual tax is lower', () => {
    // A year whose actual annualized tax stays below the (prior-year-based)
    // safe harbor: Schedule AI line amounts govern and the total is 90% of
    // the actual-year tax, not the higher prior-year target.
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 12_000,
      annualizedTaxByColumn: [10_000, 10_000, 10_000, 10_000],
    });
    expect(result.anyBenefit).toBe(true);
    expect(result.requiredCumulativeByQuarter).toEqual([2_250, 4_500, 6_750, 9_000]);
  });

  it('falls back to the regular schedule for periods that have not ended', () => {
    // Mid-June: only the Mar 31 and May 31 periods have actuals.
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 8_000,
      annualizedTaxByColumn: [4_000, 4_000, null, null],
    });
    expect(result.columns[0].chosenInstallment).toBe(900);
    expect(result.columns[1].chosenInstallment).toBe(900);
    // Open periods claim no benefit: regular installment plus the recapture
    // accumulated from the relieved columns (2 x 1100). Once column 3 pays
    // its full line 26 the recapture is consumed, so column 4 is plain 25%.
    expect(result.columns[2].aiInstallment).toBeNull();
    expect(result.columns[2].methodUsed).toBe('regular');
    expect(result.columns[2].chosenInstallment).toBe(2_000 + 2_200);
    expect(result.columns[3].chosenInstallment).toBe(2_000);
    expect(result.requiredCumulativeByQuarter[3]).toBe(8_000);
  });

  it('does not apply under the qualifying-farmer single-installment election', () => {
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 8_000,
      annualizedTaxByColumn: [1_000, 1_000, 1_000, 1_000],
      isQualifyingFarmer: true,
    });
    expect(result.applicable).toBe(false);
    expect(result.anyBenefit).toBe(false);
    expect(result.columns).toEqual([]);
    expect(result.requiredCumulativeByQuarter).toEqual([0, 0, 0, 8_000]);
  });

  it('floors a negative annualized installment at zero (line 23 "-0-" rule)', () => {
    // Column 2's cumulative target is BELOW what column 1 already required —
    // line 23 floors at zero rather than refunding.
    const result = computeAnnualizedInstallments({
      requiredAnnualPayment: 8_000,
      annualizedTaxByColumn: [8_000, 2_000, 2_000, 2_000],
    });
    expect(result.columns[0].chosenInstallment).toBe(1_800); // 8000x.225
    expect(result.columns[1].aiInstallment).toBe(0);         // 2000x.45=900 < 1800
    expect(result.columns[1].chosenInstallment).toBe(0);
  });
});
