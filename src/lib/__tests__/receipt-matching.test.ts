// src/lib/__tests__/receipt-matching.test.ts

import { describe, it, expect } from 'vitest';
import { scoreAmount, scoreDate, scoreVendor, computeMatchScore, rankCandidates } from '../receipt-matching';

describe('scoreAmount', () => {
  it('exact match returns 1.0', () => expect(scoreAmount(42.17, 42.17)).toBe(1.0));
  it('within $0.01 returns 1.0', () => expect(scoreAmount(42.17, 42.18)).toBe(1.0));
  it('within 1% returns 0.8', () => expect(scoreAmount(100.00, 100.50)).toBe(0.8));
  it('within 5% returns 0.5', () => expect(scoreAmount(100.00, 104.00)).toBe(0.5));
  it('beyond 5% returns 0.0', () => expect(scoreAmount(100.00, 110.00)).toBe(0.0));
});

describe('scoreDate', () => {
  it('same day returns 1.0', () => expect(scoreDate('2026-03-15', '2026-03-15')).toBe(1.0));
  it('1 day off returns 0.9', () => expect(scoreDate('2026-03-15', '2026-03-16')).toBe(0.9));
  it('3 days off returns 0.7', () => expect(scoreDate('2026-03-15', '2026-03-18')).toBe(0.7));
  it('7 days off returns 0.4', () => expect(scoreDate('2026-03-15', '2026-03-22')).toBe(0.4));
  it('beyond 7 days returns 0.0', () => expect(scoreDate('2026-03-15', '2026-03-30')).toBe(0.0));
});

describe('scoreVendor', () => {
  it('exact normalized match returns 1.0', () => expect(scoreVendor('COSTCO', 'costco')).toBe(1.0));
  it('substring containment returns 0.7', () => expect(scoreVendor('COSTCO', 'COSTCO WHOLESALE #482')).toBe(0.7));
  it('levenshtein < 3 returns 0.5', () => expect(scoreVendor('WALMART', 'WALMAXT')).toBe(0.5));
  it('no match returns 0.0', () => expect(scoreVendor('COSTCO', 'TARGET')).toBe(0.0));
  it('null vendor returns 0.0', () => expect(scoreVendor(null, 'TARGET')).toBe(0.0));
});

describe('computeMatchScore', () => {
  it('perfect match scores > 0.9', () => {
    const { score } = computeMatchScore(42.17, '2026-03-15', 'COSTCO', 42.17, '2026-03-15', 'COSTCO');
    expect(score).toBeGreaterThan(0.9);
  });

  it('amount only match scores ~0.5', () => {
    const { score } = computeMatchScore(42.17, null, null, 42.17, '2026-03-15', 'SOMETHING');
    expect(score).toBeCloseTo(0.5, 1);
  });
});

describe('rankCandidates', () => {
  const candidates = [
    { guid: 'a', description: 'COSTCO WHSE', post_date: '2026-03-16', amount: '42.17' },
    { guid: 'b', description: 'TARGET', post_date: '2026-03-15', amount: '42.17' },
    { guid: 'c', description: 'AMAZON', post_date: '2026-03-01', amount: '99.99' },
  ];

  it('ranks by combined score, highest first', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates);
    expect(results[0].transaction_guid).toBe('a'); // costco + close date + exact amount
  });

  it('filters below threshold', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates);
    expect(results.find(r => r.transaction_guid === 'c')).toBeUndefined(); // wrong amount
  });

  it('excludes dismissed guids', () => {
    const results = rankCandidates(42.17, '2026-03-15', 'COSTCO', candidates, ['a']);
    expect(results.find(r => r.transaction_guid === 'a')).toBeUndefined();
  });

  it('returns max 5 candidates', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      guid: `g${i}`, description: 'COSTCO', post_date: '2026-03-15', amount: '42.17',
    }));
    expect(rankCandidates(42.17, '2026-03-15', 'COSTCO', many).length).toBeLessThanOrEqual(5);
  });
});
