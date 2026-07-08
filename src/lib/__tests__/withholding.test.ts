/**
 * Withholding Checkup — pure projection tests.
 *
 * Exercises annualization from YTD + fraction-of-year, under/over-withheld
 * classification, the safe-harbor min(90% current, 100/110% prior) target,
 * the remaining quarterly estimate, the per-paycheck bump, and edge cases
 * (no payments, over-withheld, year nearly complete, no data).
 */

import { describe, it, expect } from 'vitest';
import {
  computeWithholdingCheckup,
  annualizeInputs,
  inferPayPeriodsPerYear,
  type WithholdingCheckupInput,
} from '@/lib/withholding';
import { emptyFederalInputs } from '@/lib/tax/federal';
import type { FederalTaxInputs } from '@/lib/tax/types';

function ytd(over: Partial<FederalTaxInputs> = {}): FederalTaxInputs {
  return { ...emptyFederalInputs(2025, 'single'), ...over };
}

function baseInput(over: Partial<WithholdingCheckupInput> = {}): WithholdingCheckupInput {
  return {
    year: 2025,
    filingStatus: 'single',
    elapsedYearFraction: 0.5,
    annualize: true,
    ytdInputs: ytd({ wages: 50_000 }),
    ytdWithholding: 5_000,
    ytdEstimatedPayments: 0,
    priorYearTax: null,
    priorYearAgi: null,
    remainingPayPeriods: 13,
    asOfDate: '2025-07-01',
    ...over,
  };
}

describe('annualizeInputs', () => {
  it('scales annualizable flows but leaves gains and contributions fixed', () => {
    const input = ytd({
      wages: 50_000,
      longTermCapitalGains: 4_000,
      traditional401kContributions: 10_000,
    });
    const out = annualizeInputs(input, 2);
    expect(out.wages).toBe(100_000);
    // capital gains + contributions are point-in-time / limit-bound: never annualized
    expect(out.longTermCapitalGains).toBe(4_000);
    expect(out.traditional401kContributions).toBe(10_000);
  });

  it('is a no-op when factor <= 1', () => {
    const input = ytd({ wages: 50_000 });
    expect(annualizeInputs(input, 1).wages).toBe(50_000);
    expect(annualizeInputs(input, 0.5).wages).toBe(50_000);
  });
});

describe('computeWithholdingCheckup — annualization', () => {
  it('projects a full-year figure from half-year YTD', () => {
    const c = computeWithholdingCheckup(baseInput());
    expect(c.annualized).toBe(true);
    // wages 50k YTD at half the year → 100k projected total income
    expect(c.projectedInputs.wages).toBe(100_000);
    expect(c.federal.totalIncome).toBe(100_000);
    // withholding 5k YTD → 10k projected full-year
    expect(c.projectedWithholding).toBe(10_000);
  });

  it('treats YTD as full-year when annualize is false', () => {
    const c = computeWithholdingCheckup(baseInput({ annualize: false }));
    expect(c.annualized).toBe(false);
    expect(c.projectedInputs.wages).toBe(50_000);
    expect(c.projectedWithholding).toBe(5_000);
  });
});

describe('computeWithholdingCheckup — under / over withholding classification', () => {
  it('flags under-withheld when projected payments fall short of liability', () => {
    const c = computeWithholdingCheckup(baseInput());
    // 100k single wage-earner owes well more than 10k projected withholding
    expect(c.projectedLiability).toBeGreaterThan(c.projectedWithholding);
    expect(c.underWithheld).toBe(true);
    expect(c.status).toBe('owe');
    expect(c.projectedBalance).toBeLessThan(0);
  });

  it('reports a refund when projected withholding exceeds liability', () => {
    const c = computeWithholdingCheckup(baseInput({ ytdWithholding: 30_000 }));
    // 60k projected withholding vastly exceeds the liability on 100k
    expect(c.projectedTotalPayments).toBeGreaterThan(c.projectedLiability);
    expect(c.underWithheld).toBe(false);
    expect(c.status).toBe('refund');
    expect(c.projectedBalance).toBeGreaterThan(0);
    expect(c.gapToFullLiability).toBe(0);
    expect(c.recommendedPerPaycheckBump).toBe(0);
  });
});

describe('computeWithholdingCheckup — safe harbor target', () => {
  it('uses 90% of current-year tax when no prior-year data', () => {
    const c = computeWithholdingCheckup(baseInput());
    expect(c.safeHarborBasis).toBe('90% of current-year tax');
    expect(c.safeHarbor.requiredAnnualPayment).toBeCloseTo(c.safeHarbor.ninetyPercentCurrent, 2);
  });

  it('uses 100% of prior-year tax when it is the smaller target (AGI <= 150k)', () => {
    // Prior-year tax deliberately small so the prior-year rule binds.
    const c = computeWithholdingCheckup(
      baseInput({ priorYearTax: 4_000, priorYearAgi: 90_000 }),
    );
    expect(c.safeHarborBasis).toBe('100% of prior-year tax');
    expect(c.safeHarbor.priorYearMultiplier).toBe(1.0);
    expect(c.safeHarbor.priorYearSafeHarbor).toBe(4_000);
    expect(c.safeHarbor.requiredAnnualPayment).toBe(4_000);
  });

  it('uses 110% of prior-year tax for high prior-year AGI', () => {
    const c = computeWithholdingCheckup(
      baseInput({ priorYearTax: 4_000, priorYearAgi: 200_000 }),
    );
    expect(c.safeHarborBasis).toBe('110% of prior-year tax');
    expect(c.safeHarbor.priorYearMultiplier).toBe(1.1);
    expect(c.safeHarbor.requiredAnnualPayment).toBeCloseTo(4_400, 2);
  });

  it('takes the smaller of 90%-current and prior-year (current wins when prior is larger)', () => {
    const c = computeWithholdingCheckup(
      baseInput({ priorYearTax: 500_000, priorYearAgi: 90_000 }),
    );
    expect(c.safeHarborBasis).toBe('90% of current-year tax');
    expect(c.safeHarbor.requiredAnnualPayment).toBe(c.safeHarbor.ninetyPercentCurrent);
  });
});

describe('computeWithholdingCheckup — remaining quarterly estimate', () => {
  it('sizes the next voucher to the remaining safe-harbor need and picks a future due date', () => {
    const c = computeWithholdingCheckup(baseInput());
    expect(c.remainingEstimatedPayment).toBeGreaterThan(0);
    expect(c.meetsSafeHarbor).toBe(false);
    expect(c.nextQuarter).not.toBeNull();
    // As-of 2025-07-01 → next voucher is Q3 (2025-09-15)
    expect(c.nextQuarter!.dueDate).toBe('2025-09-15');
    // Two vouchers remain (Q3, Q4) → each ~= half the remaining need
    expect(c.nextQuarter!.amount).toBeCloseTo(c.remainingEstimatedPayment / 2, 1);
  });

  it('subtracts estimated payments already made from the remaining need', () => {
    const withNone = computeWithholdingCheckup(baseInput());
    const withPaid = computeWithholdingCheckup(baseInput({ ytdEstimatedPayments: 2_000 }));
    expect(withPaid.remainingEstimatedPayment).toBeCloseTo(
      Math.max(0, withNone.safeHarbor.estimatedPaymentsNeeded - 2_000),
      2,
    );
    expect(withPaid.ytdEstimatedPayments).toBe(2_000);
  });

  it('reports no voucher once the safe-harbor target is met', () => {
    const c = computeWithholdingCheckup(baseInput({ ytdWithholding: 30_000 }));
    expect(c.meetsSafeHarbor).toBe(true);
    expect(c.remainingEstimatedPayment).toBe(0);
    expect(c.nextQuarter).toBeNull();
  });
});

describe('computeWithholdingCheckup — per-paycheck bump', () => {
  it('spreads the safe-harbor gap across remaining pay periods', () => {
    const c = computeWithholdingCheckup(baseInput({ remainingPayPeriods: 13 }));
    expect(c.recommendedPerPaycheckBump).toBeCloseTo(c.gapToSafeHarbor / 13, 2);
    expect(c.recommendedPerPaycheckBumpFull).toBeCloseTo(c.gapToFullLiability / 13, 2);
    expect(c.recommendedPerPaycheckBumpFull!).toBeGreaterThanOrEqual(c.recommendedPerPaycheckBump!);
  });

  it('returns null bumps when the remaining pay periods are unknown', () => {
    const c = computeWithholdingCheckup(baseInput({ remainingPayPeriods: null }));
    expect(c.recommendedPerPaycheckBump).toBeNull();
    expect(c.recommendedPerPaycheckBumpFull).toBeNull();
  });
});

describe('computeWithholdingCheckup — edge cases', () => {
  it('no payments yet: everything shows as owed, full liability is the gap', () => {
    const c = computeWithholdingCheckup(baseInput({ ytdWithholding: 0, ytdEstimatedPayments: 0 }));
    expect(c.hasPayments).toBe(false);
    expect(c.projectedWithholding).toBe(0);
    expect(c.underWithheld).toBe(true);
    expect(c.gapToFullLiability).toBeCloseTo(c.projectedLiability, 2);
  });

  it('year nearly complete: factor ~ 1, YTD ~ projected', () => {
    const c = computeWithholdingCheckup(
      baseInput({ elapsedYearFraction: 0.99, ytdInputs: ytd({ wages: 99_000 }), ytdWithholding: 9_900 }),
    );
    expect(c.projectedInputs.wages).toBeCloseTo(100_000, 0);
    expect(c.projectedWithholding).toBeCloseTo(10_000, 0);
    expect(c.remainingPayPeriods).toBe(13);
  });

  it('no data: hasData is false with zero income and zero payments', () => {
    const c = computeWithholdingCheckup(baseInput({ ytdInputs: ytd(), ytdWithholding: 0 }));
    expect(c.hasData).toBe(false);
    expect(c.projectedLiability).toBe(0);
  });
});

describe('inferPayPeriodsPerYear', () => {
  it('snaps to biweekly (26) with default signal', () => {
    expect(inferPayPeriodsPerYear(0, 0.5)).toBe(26);
    expect(inferPayPeriodsPerYear(13, 0.5)).toBe(26);
  });

  it('detects semi-monthly (24) and monthly (12)', () => {
    expect(inferPayPeriodsPerYear(12, 0.5)).toBe(24);
    expect(inferPayPeriodsPerYear(6, 0.5)).toBe(12);
  });

  it('detects weekly (52)', () => {
    expect(inferPayPeriodsPerYear(26, 0.5)).toBe(52);
  });
});
