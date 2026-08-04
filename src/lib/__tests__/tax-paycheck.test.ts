/**
 * Paycheck modeler — Additional Medicare threshold correctness.
 *
 * The 0.9% Additional Medicare wage threshold is §3101(b)(2), NOT the NIIT
 * threshold: QSS is $200,000 for Additional Medicare but $250,000 for NIIT.
 * A previous bug read the NIIT threshold, silently exempting QSS wages
 * between $200k and $250k.
 */

import { describe, it, expect } from 'vitest';
import { computePaycheck, type PaycheckInputs } from '@/lib/tax/paycheck';

function paycheck(over: Partial<PaycheckInputs> = {}): PaycheckInputs {
  return {
    year: 2025,
    filingStatus: 'single',
    stateCode: 'OTHER',
    stateFlatRate: 0,
    payPeriodsPerYear: 26,
    annualGross: 100_000,
    trad401kPercent: 0,
    hsaPerPaycheck: 0,
    fsaPerPaycheck: 0,
    healthPremiumPerPaycheck: 0,
    ...over,
  };
}

const MEDICARE_RATE = 0.0145;
const ADDL_RATE = 0.009;

describe('computePaycheck — Additional Medicare threshold', () => {
  it('QSS pays 0.9% above $200k (the §3101(b)(2) threshold), not $250k', () => {
    const r = computePaycheck(paycheck({ filingStatus: 'qss', annualGross: 250_000 }));
    // FICA wages 250,000 → additional medicare on 50,000 above 200k
    expect(r.annual.medicare).toBeCloseTo(
      MEDICARE_RATE * 250_000 + ADDL_RATE * 50_000,
      2,
    );
  });

  it('MFJ threshold stays $250,000 — no additional medicare at exactly 250k', () => {
    const r = computePaycheck(paycheck({ filingStatus: 'mfj', annualGross: 250_000 }));
    expect(r.annual.medicare).toBeCloseTo(MEDICARE_RATE * 250_000, 2);
  });

  it('single threshold is $200,000', () => {
    const r = computePaycheck(paycheck({ annualGross: 220_000 }));
    expect(r.annual.medicare).toBeCloseTo(
      MEDICARE_RATE * 220_000 + ADDL_RATE * 20_000,
      2,
    );
  });

  it('MFS threshold is $125,000', () => {
    const r = computePaycheck(paycheck({ filingStatus: 'mfs', annualGross: 150_000 }));
    expect(r.annual.medicare).toBeCloseTo(
      MEDICARE_RATE * 150_000 + ADDL_RATE * 25_000,
      2,
    );
  });
});
