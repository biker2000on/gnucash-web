/**
 * Numeric Conversion Tests
 *
 * Tests for GnuCash fraction-to-decimal conversion logic
 */

import { describe, it, expect } from 'vitest';
import { toDecimal, fromDecimal, generateGuid } from '../gnucash';

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
