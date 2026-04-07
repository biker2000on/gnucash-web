import { describe, it, expect } from 'vitest';
import {
  scoreAmazonAmount,
  computeAmazonMatchScore,
  rankAmazonCandidates,
  findPairMatches,
} from '../amazon-matching';

describe('scoreAmazonAmount', () => {
  it('exact match returns 1.0', () => {
    expect(scoreAmazonAmount(29.99, 29.99)).toBe(1.0);
  });

  it('within 1% returns 0.5', () => {
    // 100.00 vs 100.50 → diff=0.50, pct=0.005 → within 1%
    expect(scoreAmazonAmount(100.0, 100.5)).toBe(0.5);
  });

  it('beyond 1% returns 0.0', () => {
    // 100.00 vs 102.00 → diff=2.0, pct=0.02 → beyond 1%
    expect(scoreAmazonAmount(100.0, 102.0)).toBe(0.0);
  });
});

describe('computeAmazonMatchScore', () => {
  it('exact amount + same day returns ~1.0', () => {
    const result = computeAmazonMatchScore(49.99, '2025-01-15', 49.99, '2025-01-15');
    expect(result.score).toBeCloseTo(1.0, 1);
    expect(result.breakdown.amount).toBe(1.0);
    expect(result.breakdown.date).toBe(1.0);
  });

  it('exact amount + 3 days apart returns ~0.91', () => {
    const result = computeAmazonMatchScore(49.99, '2025-01-15', 49.99, '2025-01-18');
    // amount=1.0*0.7 + date=0.7*0.3 = 0.7 + 0.21 = 0.91
    expect(result.score).toBeCloseTo(0.91, 1);
  });

  it('no amount match returns score near 0', () => {
    const result = computeAmazonMatchScore(50.0, '2025-01-15', 100.0, '2025-01-15');
    // amount=0.0*0.7 + date=1.0*0.3 = 0.3
    expect(result.score).toBeLessThanOrEqual(0.3);
  });
});

describe('rankAmazonCandidates', () => {
  const makeCandidates = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      guid: `guid-${i}`,
      description: `Amazon order ${i}`,
      post_date: '2025-01-15',
      amount: 49.99 + i * 0.001, // slight variations to get different scores
      split_guid: `split-${i}`,
      account_guid: `acct-${i}`,
    }));

  it('returns top 5 sorted by score, filtered >= 0.3', () => {
    const candidates = [
      // exact match
      { guid: 'a', description: 'Amazon', post_date: '2025-01-15', amount: 50.0, split_guid: 's1', account_guid: 'ac1' },
      // no amount match, same day → score = 0.3
      { guid: 'b', description: 'Amazon', post_date: '2025-01-15', amount: 999.0, split_guid: 's2', account_guid: 'ac2' },
      // no amount match, far date → score = 0
      { guid: 'c', description: 'Amazon', post_date: '2024-01-01', amount: 999.0, split_guid: 's3', account_guid: 'ac3' },
      // exact match, 1 day apart
      { guid: 'd', description: 'Amazon', post_date: '2025-01-16', amount: 50.0, split_guid: 's4', account_guid: 'ac4' },
      // exact match, 3 days apart
      { guid: 'e', description: 'Amazon', post_date: '2025-01-18', amount: 50.0, split_guid: 's5', account_guid: 'ac5' },
      // exact match, 7 days apart
      { guid: 'f', description: 'Amazon', post_date: '2025-01-22', amount: 50.0, split_guid: 's6', account_guid: 'ac6' },
      // another no-match
      { guid: 'g', description: 'Amazon', post_date: '2024-06-01', amount: 1.0, split_guid: 's7', account_guid: 'ac7' },
    ];

    const result = rankAmazonCandidates(50.0, '2025-01-15', candidates);

    // Should exclude 'c' and 'g' (score 0), keep rest, max 5
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result.every(r => r.score >= 0.3)).toBe(true);
    // Should be sorted descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('excludeGuids filters out specified transactions', () => {
    const candidates = [
      { guid: 'keep', description: 'Amazon', post_date: '2025-01-15', amount: 50.0, split_guid: 's1', account_guid: 'ac1' },
      { guid: 'drop', description: 'Amazon', post_date: '2025-01-15', amount: 50.0, split_guid: 's2', account_guid: 'ac2' },
    ];

    const result = rankAmazonCandidates(50.0, '2025-01-15', candidates, ['drop']);
    expect(result.length).toBe(1);
    expect(result[0].transaction_guid).toBe('keep');
  });
});

describe('findPairMatches', () => {
  it('two orders summing to one charge within $0.05 are found', () => {
    const orders = [
      { orderId: 'order-1', amount: 25.00, orderDate: '2025-01-15' },
      { orderId: 'order-2', amount: 30.00, orderDate: '2025-01-16' },
    ];
    const charges = [
      { guid: 'charge-1', amount: 55.02, post_date: '2025-01-17', split_guid: 's1', account_guid: 'ac1' },
    ];

    const result = findPairMatches(orders, charges);
    expect(result.length).toBe(1);
    expect(result[0].orderIds).toEqual(['order-1', 'order-2']);
    expect(result[0].chargeGuid).toBe('charge-1');
    expect(result[0].sumDiff).toBeLessThanOrEqual(0.05);
  });

  it('orders outside 7-day window are not paired', () => {
    const orders = [
      { orderId: 'order-1', amount: 25.00, orderDate: '2025-01-01' },
      { orderId: 'order-2', amount: 30.00, orderDate: '2025-01-20' },
    ];
    const charges = [
      { guid: 'charge-1', amount: 55.00, post_date: '2025-01-15', split_guid: 's1', account_guid: 'ac1' },
    ];

    const result = findPairMatches(orders, charges);
    expect(result.length).toBe(0);
  });

  it('no valid pairs returns empty array', () => {
    const orders = [
      { orderId: 'order-1', amount: 10.00, orderDate: '2025-01-15' },
      { orderId: 'order-2', amount: 20.00, orderDate: '2025-01-16' },
    ];
    const charges = [
      { guid: 'charge-1', amount: 100.00, post_date: '2025-01-17', split_guid: 's1', account_guid: 'ac1' },
    ];

    const result = findPairMatches(orders, charges);
    expect(result.length).toBe(0);
  });
});
