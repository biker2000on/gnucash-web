import { describe, it, expect } from 'vitest';
import { computeStateTax, STATE_MODULES, STATE_OPTIONS } from '@/lib/tax/state';
import type { StateTaxInputs } from '@/lib/tax/types';

function si(overrides: Partial<StateTaxInputs> = {}): StateTaxInputs {
  return { year: 2025, filingStatus: 'single', federalAgi: 100_000, ...overrides };
}

describe('no-income-tax states', () => {
  it.each(['TX', 'FL', 'WA', 'NV', 'TN', 'SD', 'WY', 'AK', 'NH'])('%s computes $0', (code) => {
    const r = computeStateTax(code, si());
    expect(r.tax).toBe(0);
    expect(r.method).toBe('none');
  });
});

describe('flat states', () => {
  it('PA is 3.07% flat on the full AGI — PA has no standard deduction', () => {
    const r = computeStateTax('PA', si());
    expect(r.tax).toBeCloseTo(3_070, 2);
    expect(r.taxableIncome).toBe(100_000);
    expect(r.marginalRate).toBe(0.0307);
  });

  // Colorado taxable income starts from FEDERAL TAXABLE income (C.R.S.
  // §39-22-104(1.7)), so the federal standard deduction applies. Taxing the
  // full AGI (the pre-fix $4,400) overstated Colorado tax by ~$693.
  it('CO is 4.40% of AGI less the federal standard deduction', () => {
    const r = computeStateTax('CO', si());
    expect(r.taxableIncome).toBe(100_000 - 15_750); // 2025 single std deduction
    expect(r.tax).toBeCloseTo(0.044 * 84_250, 2);   // 3,707.00
    expect(r.marginalRate).toBe(0.044);
  });

  // A.R.S. §43-1041: Arizona's standard deduction is the federal amount.
  it('AZ is 2.50% of AGI less the federal standard deduction', () => {
    const r = computeStateTax('AZ', si());
    expect(r.taxableIncome).toBe(100_000 - 15_750);
    expect(r.tax).toBeCloseTo(0.025 * 84_250, 2);   // 2,106.25
  });

  // NCDOR: NC standard deduction is $12,750 single / $25,500 MFJ / $19,125 HOH.
  it('NC applies its $12,750 standard deduction (2025: $3,708.13 on $100k)', () => {
    const r = computeStateTax('NC', si());
    expect(r.taxableIncome).toBe(87_250);
    expect(r.tax).toBeCloseTo(3_708.13, 2);
  });

  it('NC doubles the standard deduction for joint filers', () => {
    expect(computeStateTax('NC', si({ filingStatus: 'mfj' })).taxableIncome).toBe(74_500);
    expect(computeStateTax('NC', si({ filingStatus: 'hoh' })).taxableIncome).toBe(80_875);
  });

  it('GA applies $12,000 / $24,000 (HB 1437)', () => {
    expect(computeStateTax('GA', si()).taxableIncome).toBe(88_000);
    expect(computeStateTax('GA', si({ filingStatus: 'mfj' })).taxableIncome).toBe(76_000);
  });

  it('KY standard deduction is indexed per filer', () => {
    expect(computeStateTax('KY', si({ year: 2025 })).taxableIncome).toBe(100_000 - 3_270);
    expect(computeStateTax('KY', si({ year: 2026 })).taxableIncome).toBe(100_000 - 3_360);
    // Each spouse on a joint return claims one
    expect(computeStateTax('KY', si({ year: 2025, filingStatus: 'mfj' })).taxableIncome)
      .toBe(100_000 - 6_540);
  });

  it('IL / MI / IN / UT tax the full AGI — exemptions and credits are not modeled', () => {
    for (const code of ['IL', 'MI', 'IN', 'UT']) {
      expect(computeStateTax(code, si()).taxableIncome).toBe(100_000);
    }
  });

  it('NC rate steps down by year: 4.50% / 4.25% / 3.99%', () => {
    expect(computeStateTax('NC', si({ year: 2024 })).marginalRate).toBe(0.045);
    expect(computeStateTax('NC', si({ year: 2025 })).marginalRate).toBe(0.0425);
    expect(computeStateTax('NC', si({ year: 2026 })).marginalRate).toBe(0.0399);
  });

  it('KY drops to 3.5% in 2026', () => {
    expect(computeStateTax('KY', si({ year: 2025 })).marginalRate).toBe(0.04);
    expect(computeStateTax('KY', si({ year: 2026 })).marginalRate).toBe(0.035);
  });

  it('IN drops to 2.95% in 2026', () => {
    expect(computeStateTax('IN', si({ year: 2026 })).marginalRate).toBe(0.0295);
  });
});

describe('California', () => {
  it('applies standard deduction and progressive brackets', () => {
    const r = computeStateTax('CA', si({ federalAgi: 50_000 }));
    expect(r.taxableIncome).toBe(44_460); // 50,000 − 5,540
    expect(r.method).toBe('brackets');
    expect(r.tax).toBeGreaterThan(0);
    // Manual: 1%×11,079 + 2%×15,185 + 4%×(41,452−26,264) + 6%×(44,460−41,452)
    const expected =
      0.01 * 11_079 +
      0.02 * (26_264 - 11_079) +
      0.04 * (41_452 - 26_264) +
      0.06 * (44_460 - 41_452);
    expect(r.tax).toBeCloseTo(expected, 0);
  });

  it('MFJ doubles the bracket thresholds', () => {
    const single = computeStateTax('CA', si({ federalAgi: 100_000 }));
    const mfj = computeStateTax('CA', si({ federalAgi: 100_000, filingStatus: 'mfj' }));
    expect(mfj.tax).toBeLessThan(single.tax);
  });

  it('adds 1% mental health tax over $1M taxable', () => {
    const r = computeStateTax('CA', si({ federalAgi: 2_000_000 }));
    expect(r.notes.some(n => n.includes('Mental Health'))).toBe(true);
    expect(r.marginalRate).toBeCloseTo(0.133, 5);
  });
});

describe('New York', () => {
  it('computes progressive tax with standard deduction', () => {
    const r = computeStateTax('NY', si({ federalAgi: 100_000 }));
    expect(r.taxableIncome).toBe(92_000); // 100,000 − 8,000
    // 2025 single: 4%×8,500 + 4.5%×3,200 + 5.25%×2,200 + 5.5%×66,750 + 6%×(92,000−80,650)
    const expected =
      0.04 * 8_500 +
      0.045 * (11_700 - 8_500) +
      0.0525 * (13_900 - 11_700) +
      0.055 * (80_650 - 13_900) +
      0.06 * (92_000 - 80_650);
    expect(r.tax).toBeCloseTo(expected, 0);
  });

  it('2026 uses reduced middle-class rates', () => {
    const r25 = computeStateTax('NY', si({ year: 2025, federalAgi: 100_000 }));
    const r26 = computeStateTax('NY', si({ year: 2026, federalAgi: 100_000 }));
    expect(r26.tax).toBeLessThan(r25.tax);
  });

  it('MFJ uses wider brackets', () => {
    const single = computeStateTax('NY', si({ federalAgi: 150_000 }));
    const mfj = computeStateTax('NY', si({ federalAgi: 150_000, filingStatus: 'mfj' }));
    expect(mfj.tax).toBeLessThan(single.tax);
  });
});

describe('generic fallback', () => {
  it('uses the flat rate override', () => {
    const r = computeStateTax('OTHER', si({ flatRateOverride: 0.05 }));
    expect(r.tax).toBeCloseTo(5_000, 2);
    expect(r.method).toBe('flat_override');
  });

  it('unknown state codes fall back to the generic module', () => {
    const r = computeStateTax('ZZ', si({ flatRateOverride: 0.03 }));
    expect(r.method).toBe('flat_override');
    expect(r.tax).toBeCloseTo(3_000, 2);
  });

  it('zero rate when no override entered', () => {
    expect(computeStateTax('OTHER', si()).tax).toBe(0);
  });
});

describe('registry', () => {
  it('exposes options for the UI with OTHER last', () => {
    expect(STATE_OPTIONS[STATE_OPTIONS.length - 1].code).toBe('OTHER');
    expect(STATE_OPTIONS.length).toBe(Object.keys(STATE_MODULES).length);
  });
});
