/**
 * Estimates — pure-logic tests (DB-free).
 *
 * Covers:
 *   - per-book numbering (EST-0001 style, gaps, non-matching ids ignored)
 *   - status-transition matrix ('converted' terminal, never a manual target)
 *   - line -> invoice-entry conversion (the payload handed to the invoice
 *     engine by convertEstimateToInvoice), incl. missing-account rejection
 *   - line/total math
 */

import { describe, it, expect, vi } from 'vitest';

// estimates.service imports the invoice engine (for conversion), which pulls
// in the prisma singleton — stub it so no client is instantiated.
vi.mock('@/lib/prisma', () => ({ default: {} }));

import {
  nextEstimateNo,
  canTransitionEstimate,
  estimateLinesToInvoiceEntries,
  estimateTotal,
  ESTIMATE_STATUSES,
  EstimateValidationError,
  type EstimateStatus,
} from '../estimates.service';

describe('nextEstimateNo', () => {
  it('starts at EST-0001 for an empty book', () => {
    expect(nextEstimateNo([])).toBe('EST-0001');
  });

  it('increments the max numeric suffix', () => {
    expect(nextEstimateNo(['EST-0001', 'EST-0002'])).toBe('EST-0003');
    expect(nextEstimateNo(['EST-0002', 'EST-0009', 'EST-0004'])).toBe('EST-0010');
  });

  it('handles gaps and unpadded numbers', () => {
    expect(nextEstimateNo(['EST-7', 'EST-0003'])).toBe('EST-0008');
  });

  it('ignores nulls and non-matching numbers', () => {
    expect(nextEstimateNo([null, 'Q-17', 'EST-abc', 'INV-0042'])).toBe('EST-0001');
    expect(nextEstimateNo(['custom-99', 'EST-0005'])).toBe('EST-0006');
  });

  it('is case-insensitive on the prefix but emits canonical EST-', () => {
    expect(nextEstimateNo(['est-0012'])).toBe('EST-0013');
  });

  it('grows past 4 digits without truncation', () => {
    expect(nextEstimateNo(['EST-9999'])).toBe('EST-10000');
  });
});

describe('canTransitionEstimate', () => {
  it('allows the documented forward flow', () => {
    expect(canTransitionEstimate('draft', 'sent')).toBe(true);
    expect(canTransitionEstimate('sent', 'accepted')).toBe(true);
    expect(canTransitionEstimate('sent', 'declined')).toBe(true);
  });

  it('allows re-decisions while unconverted', () => {
    expect(canTransitionEstimate('accepted', 'declined')).toBe(true);
    expect(canTransitionEstimate('declined', 'accepted')).toBe(true);
    expect(canTransitionEstimate('sent', 'draft')).toBe(true);
    expect(canTransitionEstimate('accepted', 'sent')).toBe(true);
  });

  it('treats a same-status write as a no-op transition', () => {
    for (const s of ['draft', 'sent', 'accepted', 'declined'] as EstimateStatus[]) {
      expect(canTransitionEstimate(s, s)).toBe(true);
    }
  });

  it("never allows leaving 'converted'", () => {
    for (const to of ESTIMATE_STATUSES) {
      if (to === 'converted') continue;
      expect(canTransitionEstimate('converted', to)).toBe(false);
    }
  });

  it("never allows 'converted' as a manual target", () => {
    for (const from of ESTIMATE_STATUSES) {
      expect(canTransitionEstimate(from, 'converted')).toBe(false);
    }
  });

  it('rejects skipping back from accepted/declined to draft', () => {
    expect(canTransitionEstimate('accepted', 'draft')).toBe(false);
    expect(canTransitionEstimate('declined', 'draft')).toBe(false);
  });
});

describe('estimateLinesToInvoiceEntries', () => {
  it('maps lines to invoice-engine entries 1:1', () => {
    const entries = estimateLinesToInvoiceEntries([
      { description: 'Design work', quantity: 10, unitPrice: 125, incomeAccountGuid: 'acct-1' },
      { description: null, quantity: 1, unitPrice: 500.5, incomeAccountGuid: 'acct-2' },
    ]);
    expect(entries).toEqual([
      { description: 'Design work', quantity: 10, price: 125, accountGuid: 'acct-1' },
      { description: '', quantity: 1, price: 500.5, accountGuid: 'acct-2' },
    ]);
  });

  it('rejects an empty estimate', () => {
    expect(() => estimateLinesToInvoiceEntries([])).toThrow(EstimateValidationError);
  });

  it('rejects lines without an income account, naming the line', () => {
    expect(() =>
      estimateLinesToInvoiceEntries([
        { description: 'ok', quantity: 1, unitPrice: 10, incomeAccountGuid: 'acct-1' },
        { description: 'missing', quantity: 2, unitPrice: 20, incomeAccountGuid: null },
      ]),
    ).toThrow(/Line 2/);
  });
});

describe('estimateTotal', () => {
  it('sums quantity x unitPrice with per-line cent rounding', () => {
    expect(estimateTotal([
      { quantity: 2, unitPrice: 10 },
      { quantity: 3, unitPrice: 33.333 }, // 99.999 -> 100.00 per line
    ])).toBe(120);
    expect(estimateTotal([{ quantity: 1.5, unitPrice: 99.99 }])).toBeCloseTo(149.98, 2);
  });

  it('is 0 for no lines', () => {
    expect(estimateTotal([])).toBe(0);
  });
});
