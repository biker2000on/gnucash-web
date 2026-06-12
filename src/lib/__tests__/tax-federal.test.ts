import { describe, it, expect } from 'vitest';
import {
  computeFederalTax,
  computeSeTax,
  computeSafeHarbor,
  computeTaxableSocialSecurity,
  netCapitalGains,
  taxFromBrackets,
  emptyFederalInputs,
  getYearStatusParams,
  getSsWageBase,
} from '@/lib/tax/federal';
import type { FederalTaxInputs } from '@/lib/tax/types';

function inputs(overrides: Partial<FederalTaxInputs>): FederalTaxInputs {
  return { ...emptyFederalInputs(2024, 'single'), ...overrides };
}

describe('ordinary bracket math', () => {
  it('2024 single, $100,000 taxable ordinary income → $17,053', () => {
    // wages = taxable + standard deduction (14,600)
    const r = computeFederalTax(inputs({ wages: 114_600 }));
    expect(r.taxableIncome).toBe(100_000);
    expect(r.ordinaryTax).toBeCloseTo(17_053, 0);
    expect(r.marginalRate).toBe(0.22);
  });

  it('2025 single, $100,000 taxable → $16,914 (Rev. Proc. 2024-40 brackets)', () => {
    const r = computeFederalTax(inputs({ year: 2025, wages: 115_750 }));
    expect(r.standardDeduction).toBe(15_750); // OBBBA amount
    expect(r.taxableIncome).toBe(100_000);
    expect(r.ordinaryTax).toBeCloseTo(16_914, 0);
  });

  it('2026 MFJ standard deduction is $32,200 (Rev. Proc. 2025-32)', () => {
    const r = computeFederalTax(inputs({ year: 2026, filingStatus: 'mfj', wages: 132_200 }));
    expect(r.standardDeduction).toBe(32_200);
    expect(r.taxableIncome).toBe(100_000);
  });

  it('taxFromBrackets handles zero and bracket boundaries', () => {
    const p = getYearStatusParams(2024, 'single');
    expect(taxFromBrackets(0, p.brackets)).toBe(0);
    expect(taxFromBrackets(11_600, p.brackets)).toBeCloseTo(1_160, 2);
    // exactly at second boundary: 1160 + (47150-11600)*0.12 = 5426
    expect(taxFromBrackets(47_150, p.brackets)).toBeCloseTo(5_426, 2);
  });

  it('qss uses mfj brackets', () => {
    const mfj = computeFederalTax(inputs({ filingStatus: 'mfj', wages: 229_200 }));
    const qss = computeFederalTax(inputs({ filingStatus: 'qss', wages: 229_200 }));
    expect(qss.ordinaryTax).toBe(mfj.ordinaryTax);
  });

  it('bracket fills sum to ordinary taxable income and ordinary tax', () => {
    const r = computeFederalTax(inputs({ wages: 250_000 }));
    const amountSum = r.ordinaryBracketFills.reduce((s, f) => s + f.amountInBracket, 0);
    const taxSum = r.ordinaryBracketFills.reduce((s, f) => s + f.taxInBracket, 0);
    expect(amountSum).toBeCloseTo(r.ordinaryTaxableIncome, 1);
    expect(taxSum).toBeCloseTo(r.ordinaryTax, 1);
  });
});

describe('standard vs itemized', () => {
  it('chooses itemized when larger', () => {
    const r = computeFederalTax(inputs({
      wages: 200_000,
      charitableDonations: 10_000,
      mortgageInterest: 12_000,
      stateLocalTaxesPaid: 15_000, // capped at 10k in 2024
    }));
    expect(r.itemizedBreakdown.saltAllowed).toBe(10_000);
    expect(r.itemizedDeduction).toBe(32_000);
    expect(r.usedItemized).toBe(true);
    expect(r.deductionTaken).toBe(32_000);
  });

  it('chooses standard when itemized is smaller', () => {
    const r = computeFederalTax(inputs({ wages: 100_000, charitableDonations: 2_000 }));
    expect(r.usedItemized).toBe(false);
    expect(r.deductionTaken).toBe(14_600);
  });

  it('medical expenses only count above 7.5% of AGI', () => {
    const r = computeFederalTax(inputs({ wages: 100_000, medicalExpenses: 10_000 }));
    // floor = 7500, allowed = 2500
    expect(r.itemizedBreakdown.medicalAllowed).toBe(2_500);
  });

  it('2025 SALT cap is $40,000 with OBBBA phase-down above $500k MAGI', () => {
    const low = computeFederalTax(inputs({
      year: 2025, filingStatus: 'mfj', wages: 300_000, stateLocalTaxesPaid: 50_000,
    }));
    expect(low.itemizedBreakdown.saltCap).toBe(40_000);
    expect(low.itemizedBreakdown.saltAllowed).toBe(40_000);

    const high = computeFederalTax(inputs({
      year: 2025, filingStatus: 'mfj', wages: 550_000, stateLocalTaxesPaid: 50_000,
    }));
    // cap = 40,000 − 0.3 × (550,000 − 500,000) = 25,000
    expect(high.itemizedBreakdown.saltCap).toBe(25_000);

    const veryHigh = computeFederalTax(inputs({
      year: 2025, filingStatus: 'mfj', wages: 700_000, stateLocalTaxesPaid: 50_000,
    }));
    expect(veryHigh.itemizedBreakdown.saltCap).toBe(10_000); // floored
  });

  it('2024 has the old $10k SALT cap', () => {
    const r = computeFederalTax(inputs({ wages: 600_000, stateLocalTaxesPaid: 50_000 }));
    expect(r.itemizedBreakdown.saltCap).toBe(10_000);
  });
});

describe('age 65+ and OBBBA senior deduction', () => {
  it('2024 additional standard deduction for 65+', () => {
    const r = computeFederalTax(inputs({ wages: 100_000, filersAge65Plus: 1 }));
    expect(r.standardDeduction).toBe(14_600 + 1_950);
    expect(r.seniorDeduction).toBe(0); // no OBBBA deduction in 2024
  });

  it('2025 senior deduction $6,000 with 6% phase-out over $75k', () => {
    const r = computeFederalTax(inputs({ year: 2025, wages: 95_750, filersAge65Plus: 1 }));
    // AGI = 95,750 → excess 20,750 × 6% = 1,245 → 6,000 − 1,245 = 4,755
    expect(r.agi).toBe(95_750);
    expect(r.seniorDeduction).toBeCloseTo(4_755, 2);
    expect(r.standardDeduction).toBe(15_750 + 2_000);
  });

  it('2025 senior deduction fully phased out at high income', () => {
    const r = computeFederalTax(inputs({ year: 2025, wages: 300_000, filersAge65Plus: 1 }));
    expect(r.seniorDeduction).toBe(0);
  });

  it('MFJ both 65+ gets 2x senior deduction in 2026', () => {
    const r = computeFederalTax(inputs({
      year: 2026, filingStatus: 'mfj', wages: 100_000, filersAge65Plus: 2,
    }));
    expect(r.standardDeduction).toBe(32_200 + 2 * 1_650);
    expect(r.seniorDeduction).toBe(12_000); // AGI < 150k, no phase-out
  });
});

describe('LTCG / qualified dividend stacking', () => {
  it('fills the 0% band when ordinary income is low (2024 single)', () => {
    // ordinary taxable 30,000 + LTCG 20,000; 0% band up to 47,025
    const r = computeFederalTax(inputs({
      wages: 44_600, // → 30,000 ordinary taxable
      longTermCapitalGains: 20_000,
    }));
    expect(r.ordinaryTaxableIncome).toBe(30_000);
    expect(r.preferentialIncome).toBe(20_000);
    const at0 = r.capitalGainsBracketFills.find(f => f.rate === 0)!;
    const at15 = r.capitalGainsBracketFills.find(f => f.rate === 0.15)!;
    expect(at0.amountInBracket).toBeCloseTo(17_025, 0);
    expect(at15.amountInBracket).toBeCloseTo(2_975, 0);
    expect(r.capitalGainsTax).toBeCloseTo(2_975 * 0.15, 0);
  });

  it('qualified dividends are taxed preferentially, ordinary dividends not', () => {
    const r = computeFederalTax(inputs({
      wages: 100_000,
      ordinaryDividends: 10_000,
      qualifiedDividends: 6_000,
    }));
    expect(r.preferentialIncome).toBe(6_000);
    // total income includes all 10k of dividends
    expect(r.totalIncome).toBe(110_000);
  });

  it('20% rate applies above the 15% breakpoint', () => {
    const r = computeFederalTax(inputs({
      wages: 614_600, // 600k ordinary taxable
      longTermCapitalGains: 100_000,
    }));
    const at20 = r.capitalGainsBracketFills.find(f => f.rate === 0.20)!;
    expect(at20.amountInBracket).toBe(100_000); // 600k ordinary > 518,900
  });
});

describe('capital gain netting', () => {
  it('ST loss offsets LT gain', () => {
    const n = netCapitalGains(-5_000, 20_000, 'single');
    expect(n.includedInAgi).toBe(15_000);
    expect(n.preferentialLtcg).toBe(15_000);
    expect(n.ordinaryStcg).toBe(0);
  });

  it('net loss capped at -3,000 (-1,500 MFS)', () => {
    expect(netCapitalGains(-10_000, 2_000, 'single').includedInAgi).toBe(-3_000);
    expect(netCapitalGains(-10_000, 2_000, 'mfs').includedInAgi).toBe(-1_500);
  });

  it('ST gain is ordinary, LT gain preferential', () => {
    const n = netCapitalGains(4_000, 6_000, 'single');
    expect(n.includedInAgi).toBe(10_000);
    expect(n.preferentialLtcg).toBe(6_000);
    expect(n.ordinaryStcg).toBe(4_000);
  });
});

describe('self-employment tax', () => {
  it('applies 92.35% factor and both components', () => {
    const se = computeSeTax(50_000, 2024);
    const net = 50_000 * 0.9235;
    expect(se.netEarningsFromSe).toBeCloseTo(net, 2);
    expect(se.total).toBeCloseTo(net * 0.153, 1);
    expect(se.halfDeduction).toBeCloseTo((net * 0.153) / 2, 1);
  });

  it('caps the SS portion at the wage base (2025: $176,100)', () => {
    expect(getSsWageBase(2025)).toBe(176_100);
    const se = computeSeTax(200_000, 2025);
    const net = 200_000 * 0.9235; // 184,700 > wage base
    expect(se.socialSecurityPortion).toBeCloseTo(176_100 * 0.124, 2);
    expect(se.medicarePortion).toBeCloseTo(net * 0.029, 2);
  });

  it('W-2 SS wages reduce the remaining wage base', () => {
    const se = computeSeTax(100_000, 2024, 150_000);
    const remaining = 168_600 - 150_000;
    expect(se.socialSecurityPortion).toBeCloseTo(remaining * 0.124, 2);
  });

  it('no SE tax below $400 of net earnings', () => {
    expect(computeSeTax(400, 2024).total).toBe(0);
    expect(computeSeTax(0, 2024).total).toBe(0);
    expect(computeSeTax(-5_000, 2024).total).toBe(0);
  });

  it('half-SE deduction reduces AGI in the full computation', () => {
    const r = computeFederalTax(inputs({ selfEmploymentIncome: 100_000 }));
    const se = computeSeTax(100_000, 2024);
    expect(r.agi).toBeCloseTo(100_000 - se.halfDeduction, 1);
    expect(r.selfEmploymentTax).toBe(se.total);
  });
});

describe('NIIT and Additional Medicare', () => {
  it('NIIT is 3.8% of lesser of NII or MAGI excess', () => {
    const r = computeFederalTax(inputs({ wages: 250_000, ordinaryDividends: 20_000 }));
    // MAGI 270k − 200k = 70k excess; NII = 20k → 3.8% × 20k = 760
    expect(r.niit).toBeCloseTo(760, 2);
  });

  it('NIIT limited by MAGI excess', () => {
    const r = computeFederalTax(inputs({ wages: 195_000, ordinaryDividends: 20_000 }));
    // MAGI 215k − 200k = 15k < 20k NII → 3.8% × 15k = 570
    expect(r.niit).toBeCloseTo(570, 2);
  });

  it('no NIIT below the threshold', () => {
    const r = computeFederalTax(inputs({ wages: 150_000, ordinaryDividends: 20_000 }));
    expect(r.niit).toBe(0);
  });

  it('Additional Medicare 0.9% on wages over the threshold', () => {
    const r = computeFederalTax(inputs({ wages: 250_000 }));
    expect(r.additionalMedicareTax).toBeCloseTo(450, 2);
  });

  it('MFS thresholds are $125,000', () => {
    const r = computeFederalTax(inputs({ filingStatus: 'mfs', wages: 150_000 }));
    expect(r.additionalMedicareTax).toBeCloseTo(0.009 * 25_000, 2);
  });
});

describe('pre-tax contributions', () => {
  it('traditional 401k/IRA/HSA reduce AGI', () => {
    const base = computeFederalTax(inputs({ wages: 120_000 }));
    const r = computeFederalTax(inputs({
      wages: 120_000,
      traditional401kContributions: 23_000,
      traditionalIraContributions: 7_000,
      hsaContributions: 4_150,
    }));
    expect(r.agi).toBe(120_000 - 23_000 - 7_000 - 4_150);
    expect(r.totalTax).toBeLessThan(base.totalTax);
  });
});

describe('taxable Social Security', () => {
  it('zero when provisional income below base', () => {
    expect(computeTaxableSocialSecurity(20_000, 10_000, 'single')).toBe(0);
  });

  it('50% tier between bases', () => {
    // provisional = 25,000 + 10,000 = 35,000... use other=20,000 benefits=20,000
    // provisional = 30,000 → (30,000−25,000)×0.5 = 2,500
    expect(computeTaxableSocialSecurity(20_000, 20_000, 'single')).toBe(2_500);
  });

  it('caps at 85% of benefits', () => {
    expect(computeTaxableSocialSecurity(30_000, 200_000, 'single')).toBe(25_500);
  });
});

describe('safe harbor / estimated payments', () => {
  it('uses 100% of prior year when prior AGI ≤ $150k', () => {
    const r = computeSafeHarbor({
      year: 2025, filingStatus: 'single',
      currentYearTax: 50_000, priorYearTax: 30_000, priorYearAgi: 140_000,
      withholding: 20_000,
    });
    expect(r.priorYearMultiplier).toBe(1.0);
    expect(r.priorYearSafeHarbor).toBe(30_000);
    expect(r.requiredAnnualPayment).toBe(30_000); // min(45,000, 30,000)
    expect(r.estimatedPaymentsNeeded).toBe(10_000);
  });

  it('uses 110% of prior year when prior AGI > $150k', () => {
    const r = computeSafeHarbor({
      year: 2025, filingStatus: 'single',
      currentYearTax: 40_000, priorYearTax: 30_000, priorYearAgi: 200_000,
      withholding: 0,
    });
    expect(r.priorYearMultiplier).toBe(1.1);
    expect(r.priorYearSafeHarbor).toBe(33_000);
    expect(r.requiredAnnualPayment).toBe(33_000);
  });

  it('falls back to 90% current year without prior-year data', () => {
    const r = computeSafeHarbor({
      year: 2026, filingStatus: 'mfj',
      currentYearTax: 20_000, priorYearTax: null, priorYearAgi: null,
      withholding: 15_000,
    });
    expect(r.requiredAnnualPayment).toBe(18_000);
    expect(r.estimatedPaymentsNeeded).toBe(3_000);
  });

  it('builds a 4-quarter schedule with correct due dates', () => {
    const r = computeSafeHarbor({
      year: 2026, filingStatus: 'single',
      currentYearTax: 10_000, priorYearTax: null, priorYearAgi: null,
      withholding: 0,
    });
    expect(r.quarterlySchedule.map(q => q.dueDate)).toEqual([
      '2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15',
    ]);
    const total = r.quarterlySchedule.reduce((s, q) => s + q.amount, 0);
    expect(total).toBeCloseTo(r.estimatedPaymentsNeeded, 2);
  });

  it('flags the under-$1,000 rule', () => {
    const r = computeSafeHarbor({
      year: 2025, filingStatus: 'single',
      currentYearTax: 10_500, priorYearTax: 12_000, priorYearAgi: 100_000,
      withholding: 9_800,
    });
    expect(r.underThousandDollarRule).toBe(true);
  });

  it('MFS high-AGI threshold is $75k', () => {
    const r = computeSafeHarbor({
      year: 2025, filingStatus: 'mfs',
      currentYearTax: 30_000, priorYearTax: 20_000, priorYearAgi: 100_000,
      withholding: 0,
    });
    expect(r.priorYearMultiplier).toBe(1.1);
  });
});

describe('rates and breakdown integrity', () => {
  it('effective rate = totalTax / AGI', () => {
    const r = computeFederalTax(inputs({ wages: 120_000 }));
    expect(r.effectiveRate).toBeCloseTo(r.totalTax / r.agi, 3);
  });

  it('total tax equals sum of components', () => {
    const r = computeFederalTax(inputs({
      wages: 260_000,
      ordinaryDividends: 15_000,
      qualifiedDividends: 10_000,
      longTermCapitalGains: 30_000,
      selfEmploymentIncome: 20_000,
    }));
    expect(r.totalTax).toBeCloseTo(
      r.ordinaryTax + r.capitalGainsTax + r.niit + r.additionalMedicareTax + r.selfEmploymentTax - r.credits,
      1,
    );
  });

  it('zero income produces zero tax', () => {
    const r = computeFederalTax(inputs({}));
    expect(r.totalTax).toBe(0);
    expect(r.taxableIncome).toBe(0);
  });
});
