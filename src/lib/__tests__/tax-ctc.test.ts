import { describe, it, expect } from 'vitest';
import { computeFederalTax, emptyFederalInputs } from '@/lib/tax/federal';
import type { FederalTaxInputs } from '@/lib/tax/types';

function inputs(overrides: Partial<FederalTaxInputs>): FederalTaxInputs {
  return { ...emptyFederalInputs(2025, 'mfj'), ...overrides };
}

describe('child tax credit', () => {
  it('grants $2,200 per qualifying child in 2025 below the phase-out', () => {
    const withKids = computeFederalTax(inputs({ wages: 150000, qualifyingChildrenUnder17: 2 }));
    const without = computeFederalTax(inputs({ wages: 150000 }));
    expect(withKids.credits).toBe(4400);
    expect(without.credits).toBe(0);
    expect(without.totalTax - withKids.totalTax).toBe(4400);
  });

  it('grants $2,000 per child in 2024', () => {
    const r = computeFederalTax({
      ...emptyFederalInputs(2024, 'mfj'),
      wages: 150000,
      qualifyingChildrenUnder17: 1,
    });
    expect(r.credits).toBe(2000);
  });

  it('phases out $50 per $1,000 (or fraction) of MAGI over $400k MFJ', () => {
    // Wages high enough that AGI exceeds 400k; standard deduction does not
    // affect MAGI/AGI. Excess computed on AGI.
    const r = computeFederalTax(inputs({ wages: 410000, qualifyingChildrenUnder17: 1 }));
    // AGI = 410,000 → excess 10,000 → reduction $500 → 2,200 - 500 = 1,700
    expect(r.credits).toBe(1700);
  });

  it('rounds partial $1,000 of excess up (fraction counts as full $1,000)', () => {
    const r = computeFederalTax(inputs({ wages: 400001, qualifyingChildrenUnder17: 1 }));
    // Excess $1 → one $1,000 increment → reduction $50
    expect(r.credits).toBe(2150);
  });

  it('uses the $200k threshold for single filers', () => {
    const r = computeFederalTax({
      ...emptyFederalInputs(2025, 'single'),
      wages: 210000,
      qualifyingChildrenUnder17: 1,
    });
    // Excess 10,000 → reduction 500
    expect(r.credits).toBe(1700);
  });

  it('is non-refundable: capped at income tax and never reduces SE tax', () => {
    const r = computeFederalTax(inputs({
      selfEmploymentIncome: 20000,
      qualifyingChildrenUnder17: 3,
    }));
    // Income tax is tiny/zero after the standard deduction; the credit must
    // not offset self-employment tax.
    expect(r.selfEmploymentTax).toBeGreaterThan(0);
    expect(r.totalTax).toBeGreaterThanOrEqual(Math.round(r.selfEmploymentTax * 100) / 100 - 0.01);
    expect(r.credits).toBeLessThanOrEqual(r.ordinaryTax + r.capitalGainsTax + 0.01);
  });

  it('fully phases out at very high income', () => {
    const r = computeFederalTax(inputs({ wages: 1000000, qualifyingChildrenUnder17: 2 }));
    expect(r.credits).toBe(0);
  });
});
