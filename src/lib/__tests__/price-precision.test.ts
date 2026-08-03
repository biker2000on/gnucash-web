/**
 * Price/FX storage precision tests.
 *
 * Manual price and exchange-rate entry used to store at the currency's 1/100
 * fraction, which silently truncated 1.0857 to 1.09 and rounded 0.00072 to 0.
 * Both routes now store at PRICE_DENOM; these tests pin the round-trip.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {},
  fromDecimal: vi.fn(),
  generateGuid: vi.fn(),
  toDecimal: vi.fn(),
}));

vi.mock('yahoo-finance2', () => ({ default: {} }));

// Keeps the import of PRICE_DENOM from dragging in session/book-scope config.
vi.mock('@/lib/currency', () => ({ getCurrencyByMnemonic: vi.fn() }));

import { fromDecimal, toDecimal, toDecimalNumber, MAX_INT64 } from '../gnucash';
import { PRICE_DENOM } from '../yahoo-price-service';

const CURRENCY_FRACTION = 100;

function roundTrip(value: number, denom: number): number {
  const { num, denom: d } = fromDecimal(value, denom);
  return toDecimalNumber(num, d);
}

describe('PRICE_DENOM', () => {
  it('is 1e8', () => {
    expect(PRICE_DENOM).toBe(100_000_000);
  });
});

describe('price storage round-trip at PRICE_DENOM', () => {
  it('preserves a four-decimal FX rate', () => {
    const { num, denom } = fromDecimal(1.0857, PRICE_DENOM);
    expect(num).toBe(108570000n);
    expect(denom).toBe(100000000n);
    expect(toDecimalNumber(num, denom)).toBe(1.0857);
  });

  it('preserves a sub-cent FX rate that the currency fraction zeroed out', () => {
    expect(roundTrip(0.00072, CURRENCY_FRACTION)).toBe(0);
    expect(roundTrip(0.00072, PRICE_DENOM)).toBe(0.00072);
  });

  it('preserves a sub-cent price quote', () => {
    expect(roundTrip(0.00104, CURRENCY_FRACTION)).toBe(0);
    expect(roundTrip(0.00104, PRICE_DENOM)).toBe(0.00104);
  });

  it('no longer truncates 1.0857 to 1.09', () => {
    expect(roundTrip(1.0857, CURRENCY_FRACTION)).toBe(1.09);
    expect(roundTrip(1.0857, PRICE_DENOM)).toBe(1.0857);
  });

  it('renders stored quotes as full-scale decimal strings', () => {
    const { num, denom } = fromDecimal(0.00072, PRICE_DENOM);
    expect(toDecimal(num, denom)).toBe('0.00072000');
  });

  it('keeps realistic prices inside int64', () => {
    for (const value of [0.00000001, 0.00072, 1.0857, 123.45, 1_000_000]) {
      const { num } = fromDecimal(value, PRICE_DENOM);
      expect(num).toBeLessThanOrEqual(MAX_INT64);
    }
  });

  it('flags absurd inputs as unstorable so the routes can reject them', () => {
    const { num } = fromDecimal(1e12, PRICE_DENOM);
    expect(num > MAX_INT64).toBe(true);
  });

  it('flags inputs below 1e-8 as unstorable so the routes can reject them', () => {
    const { num } = fromDecimal(1e-9, PRICE_DENOM);
    expect(num).toBe(0n);
  });
});
