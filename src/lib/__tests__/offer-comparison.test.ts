import { describe, expect, it } from 'vitest';
import {
  compareOffers,
  computeOfferScenario,
  defaultOfferScenario,
  expectedOopCost,
  resolveAnnualPay,
  DEFAULT_BILLABLE_HOURS,
  type OfferScenario,
  type SharedTaxSettings,
} from '@/lib/tax/offer-comparison';
import { computeSeTax } from '@/lib/tax/federal';

const SHARED: SharedTaxSettings = {
  year: 2026,
  filingStatus: 'single',
  stateCode: 'OTHER',
  stateFlatRate: 0.05,
};

function scenario(overrides: Partial<OfferScenario> = {}): OfferScenario {
  return {
    ...defaultOfferScenario('s1', 'Test'),
    // Neutral defaults so individual tests only see what they configure.
    holidays: 0,
    vacationDays: 0,
    employee401kPercent: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Total compensation assembly                                         */
/* ------------------------------------------------------------------ */

describe('total compensation assembly', () => {
  it('sums pay + bonus + match + other employer contrib + ESOP', () => {
    const r = computeOfferScenario(
      scenario({
        salary: 100_000,
        bonusPercent: 10,
        bonusMultiplier: 1,
        match401kPercent: 4,
        otherEmployerContrib: 1_000,
        esopPotential: 2_000,
      }),
      SHARED,
    );
    expect(r.basePay).toBe(100_000);
    expect(r.estimatedBonus).toBe(10_000);
    expect(r.employerMatch).toBe(4_000);
    expect(r.otherEmployerContrib).toBe(1_000);
    expect(r.esopPotential).toBe(2_000);
    expect(r.totalCompensation).toBe(117_000);
  });

  it('employer money counts toward total comp but not take-home', () => {
    const base = scenario({ salary: 100_000 });
    const withMatch = scenario({ salary: 100_000, match401kPercent: 6, esopPotential: 5_000 });
    const r1 = computeOfferScenario(base, SHARED);
    const r2 = computeOfferScenario(withMatch, SHARED);
    expect(r2.totalCompensation).toBe(r1.totalCompensation + 11_000);
    expect(r2.takeHomeAnnual).toBe(r1.takeHomeAnnual);
  });

  it('includes hourly overtime pay at the multiplier', () => {
    const r = computeOfferScenario(
      scenario({
        employmentType: 'hourly_w2',
        hourlyRate: 50,
        hoursPerWeek: 40,
        overtimeHoursPerYear: 100,
        overtimeMultiplier: 1.5,
      }),
      SHARED,
    );
    expect(r.basePay).toBe(50 * 40 * 52); // 104,000
    expect(r.overtimePay).toBe(50 * 1.5 * 100); // 7,500
    expect(r.totalCompensation).toBe(111_500);
    expect(r.workedHours).toBe(40 * 52 + 100);
  });
});

/* ------------------------------------------------------------------ */
/* Bonus multiplier                                                    */
/* ------------------------------------------------------------------ */

describe('bonus multiplier', () => {
  it('zeroes out an unreliable bonus at multiplier 0', () => {
    const r = computeOfferScenario(
      scenario({ salary: 100_000, bonusPercent: 15, bonusMultiplier: 0 }),
      SHARED,
    );
    expect(r.estimatedBonus).toBe(0);
  });

  it('scales the bonus and clamps the multiplier to [0, 2]', () => {
    const half = computeOfferScenario(
      scenario({ salary: 100_000, bonusPercent: 10, bonusMultiplier: 0.5 }),
      SHARED,
    );
    expect(half.estimatedBonus).toBe(5_000);
    const over = computeOfferScenario(
      scenario({ salary: 100_000, bonusPercent: 10, bonusMultiplier: 5 }),
      SHARED,
    );
    expect(over.estimatedBonus).toBe(20_000); // clamped to 2x
  });

  it('bonus feeds taxable gross for W-2 take-home', () => {
    const noBonus = computeOfferScenario(scenario({ salary: 100_000 }), SHARED);
    const withBonus = computeOfferScenario(
      scenario({ salary: 100_000, bonusPercent: 10, bonusMultiplier: 1 }),
      SHARED,
    );
    expect(withBonus.takeHomeAnnual).toBeGreaterThan(noBonus.takeHomeAnnual);
    // But less than the full $10k (taxes take a cut).
    expect(withBonus.takeHomeAnnual - noBonus.takeHomeAnnual).toBeLessThan(10_000);
  });
});

/* ------------------------------------------------------------------ */
/* PTO asymmetry: salaried vs hourly / 1099                            */
/* ------------------------------------------------------------------ */

describe('PTO asymmetry', () => {
  it('salaried: PTO adds value, pay is not reduced', () => {
    const r = computeOfferScenario(
      scenario({ salary: 104_000, holidays: 10, vacationDays: 16 }),
      SHARED,
    );
    expect(r.basePay).toBe(104_000);
    expect(r.ptoValue).toBe(26 * (104_000 / 260)); // 10,400
    expect(r.unpaidTimeOffReduction).toBe(0);
    // Overall total includes the PTO value.
    const noPto = computeOfferScenario(scenario({ salary: 104_000 }), SHARED);
    expect(r.overallAnnualTotal).toBe(noPto.overallAnnualTotal + 10_400);
  });

  it('hourly W-2: time off reduces pay instead of adding a PTO line', () => {
    const r = computeOfferScenario(
      scenario({
        employmentType: 'hourly_w2',
        hourlyRate: 50,
        hoursPerWeek: 40,
        holidays: 10,
        vacationDays: 16,
      }),
      SHARED,
    );
    expect(r.ptoValue).toBe(0);
    // 26 days x 8 hrs x $50 = $10,400 of pay lost
    expect(r.unpaidTimeOffReduction).toBe(10_400);
    expect(r.basePay).toBe(50 * (40 * 52 - 26 * 8)); // 93,600
    expect(r.workedHours).toBe(40 * 52 - 26 * 8);
  });

  it('1099 hourly: days off reduce billable hours', () => {
    const pay = resolveAnnualPay(
      scenario({
        employmentType: 'self_employed_1099',
        payBasis1099: 'hourly',
        hourlyRate: 100,
        billableHoursPerYear: DEFAULT_BILLABLE_HOURS,
        holidays: 5,
        vacationDays: 10,
      }),
    );
    expect(pay.basePay).toBe(100 * (2080 - 15 * 8)); // 196,000
    expect(pay.ptoValue).toBe(0);
    expect(pay.unpaidTimeOffReduction).toBe(12_000);
  });

  it('1099 flat: days off reduce the flat annual proportionally', () => {
    const pay = resolveAnnualPay(
      scenario({
        employmentType: 'self_employed_1099',
        payBasis1099: 'flat',
        flatAnnual1099: 260_000,
        holidays: 13,
        vacationDays: 13,
      }),
    );
    expect(pay.basePay).toBe(260_000 * (234 / 260)); // 234,000
    expect(pay.unpaidTimeOffReduction).toBe(26_000);
    expect(pay.workedHours).toBe(234 * 8);
  });

  it('same headline pay: salaried beats hourly overall when time off is taken', () => {
    const salaried = computeOfferScenario(
      scenario({ salary: 104_000, holidays: 10, vacationDays: 15 }),
      SHARED,
    );
    const hourly = computeOfferScenario(
      scenario({
        employmentType: 'hourly_w2',
        hourlyRate: 50, // 50 x 2080 = 104,000 headline
        hoursPerWeek: 40,
        holidays: 10,
        vacationDays: 15,
      }),
      SHARED,
    );
    expect(salaried.overallAnnualTotal).toBeGreaterThan(hourly.overallAnnualTotal);
  });
});

/* ------------------------------------------------------------------ */
/* Expected out-of-pocket cost                                         */
/* ------------------------------------------------------------------ */

describe('expectedOopCost', () => {
  it('below the deductible: you pay what was billed', () => {
    expect(expectedOopCost(3_000, 6_000, 20, 1_000)).toBe(1_000);
  });

  it('between deductible and OOP max: deductible + coinsurance share', () => {
    // 3,000 + 20% x (5,000 - 3,000) = 3,400
    expect(expectedOopCost(3_000, 6_000, 20, 5_000)).toBe(3_400);
  });

  it('capped at the OOP max for catastrophic care', () => {
    expect(expectedOopCost(3_000, 6_000, 20, 100_000)).toBe(6_000);
  });

  it('zero billed care costs nothing', () => {
    expect(expectedOopCost(3_000, 6_000, 20, 0)).toBe(0);
  });

  it('no OOP max set means no cap', () => {
    expect(expectedOopCost(3_000, 0, 20, 100_000)).toBe(3_000 + 0.2 * 97_000);
  });
});

/* ------------------------------------------------------------------ */
/* Healthcare all-in cost & HDHP tax value                             */
/* ------------------------------------------------------------------ */

describe('all-in healthcare cost', () => {
  it('assembles premiums + expected OOP - HSA seed - HSA tax value', () => {
    const r = computeOfferScenario(
      scenario({
        salary: 100_000,
        medicalPremiumMonthly: 200,
        dentalPremiumMonthly: 30,
        otherPremiumMonthly: 20,
        hsaSeed: 1_000,
        deductible: 3_000,
        oopMax: 6_000,
        coinsurancePercentAfterDeductible: 20,
        expectedAnnualCareBilled: 5_000,
        isHdhp: false,
      }),
      SHARED,
    );
    expect(r.premiumsAnnual).toBe(3_000);
    expect(r.expectedOopCost).toBe(3_400);
    expect(r.hsaTaxValue).toBe(0);
    expect(r.allInHealthcareCost).toBe(3_000 + 3_400 - 1_000);
  });

  it('HDHP: employee HSA contribution earns a tax-value credit at the marginal rate', () => {
    const base = scenario({
      salary: 100_000,
      hsaPerPaycheck: 100,
      payPeriodsPerYear: 26,
    });
    const nonHdhp = computeOfferScenario({ ...base, isHdhp: false }, SHARED);
    const hdhp = computeOfferScenario({ ...base, isHdhp: true }, SHARED);
    expect(nonHdhp.hsaTaxValue).toBe(0);
    expect(hdhp.hsaTaxValue).toBeCloseTo(2_600 * hdhp.combinedMarginalRate, 2);
    expect(hdhp.hsaTaxValue).toBeGreaterThan(0);
    expect(hdhp.allInHealthcareCost).toBeCloseTo(
      nonHdhp.allInHealthcareCost - hdhp.hsaTaxValue,
      2,
    );
    // Same take-home either way — the HDHP credit lives in the healthcare line.
    expect(hdhp.takeHomeAnnual).toBe(nonHdhp.takeHomeAnnual);
  });

  it('healthcare cost reduces the overall annual total', () => {
    const free = computeOfferScenario(scenario({ salary: 100_000 }), SHARED);
    const costly = computeOfferScenario(
      scenario({ salary: 100_000, medicalPremiumMonthly: 500 }),
      SHARED,
    );
    expect(costly.overallAnnualTotal).toBe(free.overallAnnualTotal - 6_000);
  });
});

/* ------------------------------------------------------------------ */
/* 1099 / SE-tax path                                                  */
/* ------------------------------------------------------------------ */

describe('self-employed 1099 path', () => {
  it('charges Schedule SE tax (both halves) against the overall total', () => {
    const s = scenario({
      employmentType: 'self_employed_1099',
      payBasis1099: 'hourly',
      hourlyRate: 100,
      billableHoursPerYear: 2_080,
    });
    const r = computeOfferScenario(s, SHARED);
    const expectedSe = computeSeTax(208_000, 2026).total;
    expect(r.seTax).toBe(expectedSe);
    expect(r.overallAnnualTotal).toBe(r.totalCompensation - r.allInHealthcareCost - expectedSe);
  });

  it('deductions percent reduces taxable profit and SE tax', () => {
    const gross = scenario({
      employmentType: 'self_employed_1099',
      payBasis1099: 'flat',
      flatAnnual1099: 150_000,
    });
    const withDeductions = { ...gross, deductionsPercent1099: 20 };
    const r1 = computeOfferScenario(gross, SHARED);
    const r2 = computeOfferScenario(withDeductions, SHARED);
    expect(r2.seTax).toBe(computeSeTax(120_000, 2026).total);
    expect(r2.seTax).toBeLessThan(r1.seTax);
    expect(r2.takeHomeAnnual).toBeLessThan(r1.takeHomeAnnual);
  });

  it('provides an S-corp savings hint when profitable', () => {
    const r = computeOfferScenario(
      scenario({
        employmentType: 'self_employed_1099',
        payBasis1099: 'flat',
        flatAnnual1099: 200_000,
      }),
      SHARED,
    );
    expect(r.scorpSavingsHint).not.toBeNull();
    expect(r.scorpSavingsHint!).toBeGreaterThan(0);
  });

  it('no S-corp hint at zero revenue', () => {
    const r = computeOfferScenario(
      scenario({ employmentType: 'self_employed_1099', payBasis1099: 'flat', flatAnnual1099: 0 }),
      SHARED,
    );
    expect(r.scorpSavingsHint).toBeNull();
    expect(r.seTax).toBe(0);
  });

  it('W-2 scenarios have zero SE tax and no S-corp hint', () => {
    const r = computeOfferScenario(scenario({ salary: 150_000 }), SHARED);
    expect(r.seTax).toBe(0);
    expect(r.scorpSavingsHint).toBeNull();
  });

  it('1099 take-home is net of income tax, SE tax, deferrals, and premiums', () => {
    const r = computeOfferScenario(
      scenario({
        employmentType: 'self_employed_1099',
        payBasis1099: 'flat',
        flatAnnual1099: 150_000,
        medicalPremiumMonthly: 400,
      }),
      SHARED,
    );
    const noPremium = computeOfferScenario(
      scenario({
        employmentType: 'self_employed_1099',
        payBasis1099: 'flat',
        flatAnnual1099: 150_000,
      }),
      SHARED,
    );
    expect(r.takeHomeAnnual).toBe(noPremium.takeHomeAnnual - 4_800);
    expect(r.takeHomeAnnual).toBeLessThan(150_000);
  });
});

/* ------------------------------------------------------------------ */
/* Delta vs baseline                                                   */
/* ------------------------------------------------------------------ */

describe('compareOffers deltas', () => {
  it('computes $ and % deltas against the baseline; baseline delta is null', () => {
    const a = scenario({ salary: 100_000 });
    const b = { ...scenario({ salary: 120_000 }), id: 's2', name: 'Offer' };
    const { results, baselineId } = compareOffers([a, b], 's1', SHARED);

    expect(baselineId).toBe('s1');
    expect(results[0].deltaVsBaseline).toBeNull();

    const delta = results[1].deltaVsBaseline!;
    const expectedAmount = results[1].overallAnnualTotal - results[0].overallAnnualTotal;
    expect(delta.amount).toBeCloseTo(expectedAmount, 2);
    expect(delta.percent).toBeCloseTo(expectedAmount / results[0].overallAnnualTotal, 4);
    expect(delta.amount).toBeGreaterThan(0);
  });

  it('falls back to the first scenario when the baseline id is missing', () => {
    const a = scenario({ salary: 100_000 });
    const b = { ...scenario({ salary: 90_000 }), id: 's2', name: 'B' };
    const { results, baselineId } = compareOffers([a, b], 'nonexistent', SHARED);
    expect(baselineId).toBe('s1');
    expect(results[0].deltaVsBaseline).toBeNull();
    expect(results[1].deltaVsBaseline!.amount).toBeLessThan(0);
  });

  it('handles an empty scenario list', () => {
    const { results } = compareOffers([], 'x', SHARED);
    expect(results).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Derived metrics                                                     */
/* ------------------------------------------------------------------ */

describe('derived metrics', () => {
  it('monthly figures are annual / 12', () => {
    const r = computeOfferScenario(scenario({ salary: 120_000 }), SHARED);
    expect(r.overallMonthly).toBeCloseTo(r.overallAnnualTotal / 12, 2);
    expect(r.takeHomeMonthly).toBeCloseTo(r.takeHomeAnnual / 12, 2);
  });

  it('effective hourly rate divides the overall total by worked hours', () => {
    const r = computeOfferScenario(
      scenario({ salary: 104_000, holidays: 10, vacationDays: 16 }),
      SHARED,
    );
    expect(r.workedHours).toBe((260 - 26) * 8);
    expect(r.effectiveHourlyRate).toBeCloseTo(r.overallAnnualTotal / r.workedHours, 2);
  });

  it('zero worked hours yields a zero effective rate (no division blowup)', () => {
    const r = computeOfferScenario(
      scenario({
        employmentType: 'hourly_w2',
        hourlyRate: 50,
        hoursPerWeek: 40,
        holidays: 260,
        vacationDays: 100,
      }),
      SHARED,
    );
    expect(r.workedHours).toBe(0);
    expect(r.effectiveHourlyRate).toBe(0);
  });
});
