/**
 * Numeric Conversion Tests
 *
 * Tests for GnuCash fraction-to-decimal conversion logic
 */

import { describe, it, expect } from 'vitest';
import { toDecimal, toDecimalNumber, fromDecimal, generateGuid } from '../gnucash';

describe('toDecimal', () => {
  it('should convert 100/100 to "1"', () => {
    expect(toDecimal(100n, 100n)).toBe('1');
  });

  it('should convert 150/100 to "1.50"', () => {
    expect(toDecimal(150n, 100n)).toBe('1.50');
  });

  it('should convert -50/100 to "-0.50"', () => {
    expect(toDecimal(-50n, 100n)).toBe('-0.50');
  });

  it('should convert 0/100 to "0"', () => {
    expect(toDecimal(0n, 100n)).toBe('0');
  });

  it('should convert 12345/1000 to "12.345"', () => {
    expect(toDecimal(12345n, 1000n)).toBe('12.345');
  });

  it('should handle zero denominator safely', () => {
    expect(toDecimal(100n, 0n)).toBe('0');
  });

  it('should convert large values correctly', () => {
    expect(toDecimal(999999999n, 100n)).toBe('9999999.99');
  });

  it('should handle string inputs', () => {
    expect(toDecimal('150', '100')).toBe('1.50');
  });

  it('should handle number inputs', () => {
    expect(toDecimal(150, 100)).toBe('1.50');
  });

  it('should convert negative values correctly', () => {
    expect(toDecimal(-12345n, 100n)).toBe('-123.45');
  });

  it('should handle 1/1 fractions', () => {
    expect(toDecimal(42n, 1n)).toBe('42');
  });

  it('should handle investment fractions (10000 denominator)', () => {
    expect(toDecimal(123456n, 10000n)).toBe('12.3456');
  });

  // GCD-reduced price rows (implied-price service) leave arbitrary
  // denominators in the prices table; these must decode exactly, not by
  // padding the remainder against the denominator's digit count.
  describe('non-power-of-ten denominators', () => {
    it('should convert 1/8 to "0.125"', () => {
      expect(toDecimal(1n, 8n)).toBe('0.125');
    });

    it('should convert 5/16 to "0.3125"', () => {
      expect(toDecimal(5n, 16n)).toBe('0.3125');
    });

    it('should convert 3/64 to "0.046875"', () => {
      expect(toDecimal(3n, 64n)).toBe('0.046875');
    });

    it('should convert 1/256 to "0.00390625"', () => {
      expect(toDecimal(1n, 256n)).toBe('0.00390625');
    });

    it('should convert 7/2000 to "0.0035"', () => {
      expect(toDecimal(7n, 2000n)).toBe('0.0035');
    });

    // Non-terminating quotients are capped at a display-sane scale because
    // these strings reach the UI raw via the Prisma computed decimal fields.
    it('should round repeating fractions half-up at the capped scale', () => {
      expect(toDecimal(1n, 3n)).toBe('0.3333333333');
      expect(toDecimal(2n, 3n)).toBe('0.6666666667');
      expect(toDecimal(1n, 6n)).toBe('0.1666666667');
    });

    it('should decode a real GCD-reduced price row', () => {
      expect(toDecimal(8727032n, 58502535n)).toBe('0.14917357');
    });

    it('should keep the sign on non-power-of-ten denominators', () => {
      expect(toDecimal(-1n, 8n)).toBe('-0.125');
      expect(toDecimal(-3n, 64n)).toBe('-0.046875');
    });

    it('should still return the bare integer when the fraction divides evenly', () => {
      expect(toDecimal(16n, 8n)).toBe('2');
      expect(toDecimal(-24n, 8n)).toBe('-3');
    });

    it('should carry the integer part alongside an odd denominator', () => {
      expect(toDecimal(25n, 8n)).toBe('3.125');
    });
  });
});

describe('toDecimalNumber', () => {
  it('should convert fractions to numbers', () => {
    expect(toDecimalNumber(150n, 100n)).toBe(1.5);
  });
  it('should return 0 for null inputs', () => {
    expect(toDecimalNumber(null, 100n)).toBe(0);
    expect(toDecimalNumber(150n, null)).toBe(0);
    expect(toDecimalNumber(null, null)).toBe(0);
  });
  it('should handle negative values', () => {
    expect(toDecimalNumber(-50n, 100n)).toBe(-0.5);
  });
  it('should handle non-power-of-ten denominators', () => {
    expect(toDecimalNumber(1n, 8n)).toBe(0.125);
    expect(toDecimalNumber(1n, 256n)).toBe(0.00390625);
    expect(toDecimalNumber(1n, 3n)).toBeCloseTo(1 / 3, 9);
    expect(toDecimalNumber(8727032n, 58502535n)).toBe(0.14917357);
  });
  it('should return 0 for a zero denominator', () => {
    expect(toDecimalNumber(100n, 0n)).toBe(0);
  });
});

describe('fromDecimal', () => {
  it('should convert 1.50 to 150/100', () => {
    const result = fromDecimal(1.50, 100);
    expect(result.num).toBe(150n);
    expect(result.denom).toBe(100n);
  });

  it('should convert -0.50 to -50/100', () => {
    const result = fromDecimal(-0.50, 100);
    expect(result.num).toBe(-50n);
    expect(result.denom).toBe(100n);
  });

  it('should use default denominator of 100', () => {
    const result = fromDecimal(1.23);
    expect(result.num).toBe(123n);
    expect(result.denom).toBe(100n);
  });

  it('should handle rounding correctly', () => {
    const result = fromDecimal(1.999, 100);
    expect(result.num).toBe(200n);
    expect(result.denom).toBe(100n);
  });

  it('should support custom denominators', () => {
    const result = fromDecimal(1.2345, 10000);
    expect(result.num).toBe(12345n);
    expect(result.denom).toBe(10000n);
  });
});

describe('generateGuid', () => {
  it('should generate a 32-character string', () => {
    const guid = generateGuid();
    expect(guid).toHaveLength(32);
  });

  it('should generate lowercase hex characters only', () => {
    const guid = generateGuid();
    expect(guid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should generate unique values', () => {
    const guids = new Set();
    for (let i = 0; i < 100; i++) {
      guids.add(generateGuid());
    }
    expect(guids.size).toBe(100);
  });
});
