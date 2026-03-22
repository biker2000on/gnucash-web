// src/lib/__tests__/receipt-extraction.test.ts

import { describe, it, expect } from 'vitest';
import { extractAmount, extractDate, extractVendor, normalizeVendor, extractWithRegex } from '../receipt-extraction';

describe('extractAmount', () => {
  it('extracts dollar amount with $ prefix', () => {
    expect(extractAmount('Items $42.17')).toBe(42.17);
  });

  it('extracts TOTAL amount', () => {
    expect(extractAmount('Subtotal: $38.75\nTax: $3.42\nTOTAL: $42.17')).toBe(42.17);
  });

  it('extracts amount with comma separator', () => {
    expect(extractAmount('GRAND TOTAL $1,234.56')).toBe(1234.56);
  });

  it('returns largest amount (likely total)', () => {
    expect(extractAmount('Item $5.99\nItem $3.49\nTotal $9.48')).toBe(9.48);
  });

  it('returns null for no amounts', () => {
    expect(extractAmount('No amounts here')).toBeNull();
  });
});

describe('extractDate', () => {
  it('extracts MM/DD/YYYY', () => {
    expect(extractDate('Date: 03/15/2026')).toBe('2026-03-15');
  });

  it('extracts YYYY-MM-DD', () => {
    expect(extractDate('2026-03-15 Receipt')).toBe('2026-03-15');
  });

  it('extracts MM/DD/YY', () => {
    expect(extractDate('03/15/26')).toBe('2026-03-15');
  });

  it('extracts Mon DD, YYYY', () => {
    expect(extractDate('Mar 15, 2026')).toBe('2026-03-15');
  });

  it('returns null for no dates', () => {
    expect(extractDate('No date here')).toBeNull();
  });
});

describe('extractVendor', () => {
  it('returns first non-numeric line', () => {
    expect(extractVendor('COSTCO WHOLESALE #482\n123 Main St\n03/15/2026')).toBe('COSTCO WHOLESALE #482');
  });

  it('skips numeric-only lines', () => {
    expect(extractVendor('12345\nSHELL GAS STATION\n$38.50')).toBe('SHELL GAS STATION');
  });

  it('returns null for empty text', () => {
    expect(extractVendor('')).toBeNull();
  });
});

describe('normalizeVendor', () => {
  it('lowercases and strips numbers', () => {
    expect(normalizeVendor('COSTCO WHOLESALE #482')).toBe('costco wholesale');
  });

  it('collapses whitespace', () => {
    expect(normalizeVendor('  SHELL  GAS  123  ')).toBe('shell gas');
  });

  it('returns null for null input', () => {
    expect(normalizeVendor(null)).toBeNull();
  });
});

describe('extractWithRegex', () => {
  it('extracts all fields from typical receipt', () => {
    const text = 'COSTCO WHOLESALE #482\n123 Main St\n03/15/2026\nMILK 2% $4.99\nBREAD $3.49\nTOTAL $8.48';
    const result = extractWithRegex(text);
    expect(result.amount).toBe(8.48);
    expect(result.date).toBe('2026-03-15');
    expect(result.vendor).toBe('COSTCO WHOLESALE #482');
    expect(result.extraction_method).toBe('regex');
  });
});
