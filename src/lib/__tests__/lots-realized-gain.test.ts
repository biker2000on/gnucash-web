/**
 * computeRealizedGain tests — native GnuCash sign convention.
 *
 * Buy split on the stock account: positive quantity, POSITIVE value (debit).
 * Sell split: negative quantity, NEGATIVE value (credit).
 * Gains offset splits (scrub-generated or GnuCash desktop): zero quantity,
 * non-zero value, recorded inside the lot so it sums to zero.
 */

import { describe, it, expect } from 'vitest';
import { computeRealizedGain } from '../lots';

describe('computeRealizedGain', () => {
  it('closed unscrubbed lot: gain = proceeds - basis = -(sum of values)', () => {
    // Buy 10 @ $100 (+1000), sell 10 @ $150 (-1500): gain $500
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -1500 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(500);
  });

  it('closed unscrubbed lot with a loss returns a negative gain', () => {
    // Buy 10 @ $100 (+1000), sell 10 @ $80 (-800): loss $200
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -800 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(-200);
  });

  it('scrubbed closed lot: excludes the zero-qty gains offset split', () => {
    // Same trade, plus the scrub-generated offset (+500) that zeroes the lot.
    // Without the exclusion the naive sum would report 0.
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -10, value: -1500 },
      { shares: 0, value: 500 }, // gains offset
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(500);
  });

  it('open lot with no sells: zero realized gain', () => {
    const splits = [{ shares: 10, value: 1000 }];
    expect(computeRealizedGain(splits, false)).toBe(0);
  });

  it('open partially-sold lot: realized portion only', () => {
    // Buy 10 @ $100, sell 4 @ $150: realized = 600 - 4*100 = $200
    const splits = [
      { shares: 10, value: 1000 },
      { shares: -4, value: -600 },
    ];
    expect(computeRealizedGain(splits, false)).toBeCloseTo(200);
  });

  it('lot from a zero-value transfer-in treats proceeds as full gain', () => {
    // Transfer-in with no value recorded, then sell: basis unknown => 0
    const splits = [
      { shares: 10, value: 0 },
      { shares: -10, value: -1500 },
    ];
    expect(computeRealizedGain(splits, true)).toBeCloseTo(1500);
  });
});
