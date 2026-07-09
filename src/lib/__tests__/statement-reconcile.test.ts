import { describe, it, expect } from 'vitest';
import {
  matchStatementLines,
  computeReconcileTieOut,
  splitValueToStatementAmount,
  statementAmountToSplitValue,
  negateSplitValue,
  AMOUNT_EPSILON,
  DEFAULT_MATCH_WINDOW_DAYS,
  type StatementLineInput,
  type LedgerSplitInput,
} from '@/lib/statement-reconcile';

const d = (iso: string) => new Date(iso + 'T00:00:00Z');

describe('matchStatementLines', () => {
  it('matches an exact-amount pair within the date window', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: -25.5 }];
    const splits: LedgerSplitInput[] = [
      { splitGuid: 's1', date: d('2026-01-12'), amountSigned: -25.5, reconcileState: 'n' },
    ];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    expect(res.matched).toEqual([{ lineId: 1, splitGuid: 's1' }]);
    expect(res.missingOnStatement).toEqual([]);
    expect(res.inLedgerNotOnStatement).toEqual([]);
  });

  it('does NOT match when the split is outside the date window', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 100 }];
    const splits: LedgerSplitInput[] = [{ splitGuid: 's1', date: d('2026-01-20'), amountSigned: 100 }];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    expect(res.matched).toEqual([]);
    expect(res.missingOnStatement).toEqual([1]);
    expect(res.inLedgerNotOnStatement).toEqual(['s1']);
  });

  it('matches exactly at the window boundary (windowDays inclusive)', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 100 }];
    const splits: LedgerSplitInput[] = [{ splitGuid: 's1', date: d('2026-01-14'), amountSigned: 100 }];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    expect(res.matched).toEqual([{ lineId: 1, splitGuid: 's1' }]);
  });

  it('breaks ties by the closest date', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 50 }];
    const splits: LedgerSplitInput[] = [
      { splitGuid: 'far', date: d('2026-01-13'), amountSigned: 50 },
      { splitGuid: 'near', date: d('2026-01-11'), amountSigned: 50 },
    ];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    expect(res.matched).toEqual([{ lineId: 1, splitGuid: 'near' }]);
    expect(res.inLedgerNotOnStatement).toEqual(['far']);
  });

  it('uses each split at most once (two equal lines, two equal splits)', () => {
    const lines: StatementLineInput[] = [
      { lineId: 1, date: d('2026-01-10'), amountSigned: 20 },
      { lineId: 2, date: d('2026-01-11'), amountSigned: 20 },
    ];
    const splits: LedgerSplitInput[] = [
      { splitGuid: 'a', date: d('2026-01-10'), amountSigned: 20 },
      { splitGuid: 'b', date: d('2026-01-11'), amountSigned: 20 },
    ];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    // Each line claims its own split; line 1 (earliest) claims the closest.
    expect(res.matched).toHaveLength(2);
    const byLine = Object.fromEntries(res.matched.map((m) => [m.lineId, m.splitGuid]));
    expect(byLine[1]).toBe('a');
    expect(byLine[2]).toBe('b');
    expect(res.inLedgerNotOnStatement).toEqual([]);
  });

  it('does not double-use one split for two lines', () => {
    const lines: StatementLineInput[] = [
      { lineId: 1, date: d('2026-01-10'), amountSigned: 20 },
      { lineId: 2, date: d('2026-01-10'), amountSigned: 20 },
    ];
    const splits: LedgerSplitInput[] = [{ splitGuid: 'only', date: d('2026-01-10'), amountSigned: 20 }];
    const res = matchStatementLines(lines, splits, { windowDays: 4 });
    expect(res.matched).toHaveLength(1);
    expect(res.matched[0].splitGuid).toBe('only');
    expect(res.missingOnStatement).toHaveLength(1); // the other line is unmatched
  });

  it('puts unmatched statement lines into the missingOnStatement (add) bucket', () => {
    const lines: StatementLineInput[] = [
      { lineId: 1, date: d('2026-01-10'), amountSigned: -12.34 },
      { lineId: 2, date: d('2026-01-11'), amountSigned: -99.99 },
    ];
    const splits: LedgerSplitInput[] = [{ splitGuid: 's1', date: d('2026-01-10'), amountSigned: -12.34 }];
    const res = matchStatementLines(lines, splits);
    expect(res.matched).toEqual([{ lineId: 1, splitGuid: 's1' }]);
    expect(res.missingOnStatement).toEqual([2]);
  });

  it('puts ledger-only splits into the inLedgerNotOnStatement bucket', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 5 }];
    const splits: LedgerSplitInput[] = [
      { splitGuid: 'matched', date: d('2026-01-10'), amountSigned: 5 },
      { splitGuid: 'pending', date: d('2026-01-10'), amountSigned: -40 },
    ];
    const res = matchStatementLines(lines, splits);
    expect(res.matched).toEqual([{ lineId: 1, splitGuid: 'matched' }]);
    expect(res.inLedgerNotOnStatement).toEqual(['pending']);
  });

  it('uses the default window of 4 days when unspecified', () => {
    expect(DEFAULT_MATCH_WINDOW_DAYS).toBe(4);
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 1 }];
    const inWindow: LedgerSplitInput[] = [{ splitGuid: 's', date: d('2026-01-14'), amountSigned: 1 }];
    const outWindow: LedgerSplitInput[] = [{ splitGuid: 's', date: d('2026-01-15'), amountSigned: 1 }];
    expect(matchStatementLines(lines, inWindow).matched).toHaveLength(1);
    expect(matchStatementLines(lines, outWindow).matched).toHaveLength(0);
  });

  it('does not match different amounts (even within window)', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 100 }];
    const splits: LedgerSplitInput[] = [{ splitGuid: 's', date: d('2026-01-10'), amountSigned: 100.01 }];
    expect(matchStatementLines(lines, splits).matched).toHaveLength(0);
  });

  it('tolerates sub-epsilon float noise on amounts', () => {
    const lines: StatementLineInput[] = [{ lineId: 1, date: d('2026-01-10'), amountSigned: 100 }];
    const splits: LedgerSplitInput[] = [
      { splitGuid: 's', date: d('2026-01-10'), amountSigned: 100 + AMOUNT_EPSILON / 2 },
    ];
    expect(matchStatementLines(lines, splits).matched).toHaveLength(1);
  });

  it('handles empty inputs', () => {
    expect(matchStatementLines([], [])).toEqual({
      matched: [],
      missingOnStatement: [],
      inLedgerNotOnStatement: [],
    });
    expect(matchStatementLines([], [{ splitGuid: 's', date: d('2026-01-10'), amountSigned: 1 }])).toEqual({
      matched: [],
      missingOnStatement: [],
      inLedgerNotOnStatement: ['s'],
    });
    expect(matchStatementLines([{ lineId: 1, date: d('2026-01-10'), amountSigned: 1 }], [])).toEqual({
      matched: [],
      missingOnStatement: [1],
      inLedgerNotOnStatement: [],
    });
  });
});

describe('computeReconcileTieOut', () => {
  it('ties out when matched + added equals closing - opening', () => {
    const r = computeReconcileTieOut({
      openingBalance: 1000,
      closingBalance: 1200,
      matchedSplitsAmount: 150,
      addedLinesAmount: 50,
    });
    expect(r.expectedChange).toBe(200);
    expect(r.actualChange).toBe(200);
    expect(r.difference).toBe(0);
    expect(r.tiesOut).toBe(true);
  });

  it('does not tie out when there is a real difference', () => {
    const r = computeReconcileTieOut({
      openingBalance: 1000,
      closingBalance: 1200,
      matchedSplitsAmount: 150,
      addedLinesAmount: 0,
    });
    expect(r.expectedChange).toBe(200);
    expect(r.actualChange).toBe(150);
    expect(r.difference).toBe(50);
    expect(r.tiesOut).toBe(false);
  });

  it('ties out within the half-cent tolerance', () => {
    const r = computeReconcileTieOut({
      openingBalance: 0,
      closingBalance: 100,
      matchedSplitsAmount: 100.004,
      addedLinesAmount: 0,
    });
    expect(r.tiesOut).toBe(true);
  });

  it('returns unknown (null) when opening balance is missing', () => {
    const r = computeReconcileTieOut({
      openingBalance: null,
      closingBalance: 1200,
      matchedSplitsAmount: 150,
      addedLinesAmount: 50,
    });
    expect(r.expectedChange).toBeNull();
    expect(r.difference).toBeNull();
    expect(r.tiesOut).toBeNull();
    expect(r.actualChange).toBe(200); // still reported
  });

  it('returns unknown (null) when closing balance is missing', () => {
    const r = computeReconcileTieOut({
      openingBalance: 1000,
      closingBalance: undefined,
      matchedSplitsAmount: 0,
      addedLinesAmount: 0,
    });
    expect(r.tiesOut).toBeNull();
  });

  it('handles a credit-card (negative change) statement', () => {
    // Opening owe $500 (raw -500), spent $200 more, closing owe $700 (raw -700).
    const r = computeReconcileTieOut({
      openingBalance: -500,
      closingBalance: -700,
      matchedSplitsAmount: -200, // a $200 charge = money out
      addedLinesAmount: 0,
    });
    expect(r.expectedChange).toBe(-200);
    expect(r.actualChange).toBe(-200);
    expect(r.tiesOut).toBe(true);
  });
});

describe('sign conversion (asset vs credit-card)', () => {
  it('asset: a deposit is money in (positive)', () => {
    // +$100.00 stored as 10000/100
    expect(splitValueToStatementAmount(10000n, 100n)).toBe(100);
  });

  it('asset: a withdrawal is money out (negative)', () => {
    expect(splitValueToStatementAmount(-5000n, 100n)).toBe(-50);
  });

  it('credit-card: a charge REDUCES the account (native negative → statement negative)', () => {
    // A $100 charge is a credit to the liability → raw value_num = -10000.
    expect(splitValueToStatementAmount(-10000n, 100n)).toBe(-100);
  });

  it('credit-card: a payment INCREASES the account (native positive → statement positive)', () => {
    // A $250 payment pays the card down → debit → raw value_num = +25000.
    expect(splitValueToStatementAmount(25000n, 100n)).toBe(250);
  });

  it('round-trips a statement amount to a split value and back', () => {
    const v = statementAmountToSplitValue(-100, 100);
    expect(v).toEqual({ num: -10000n, denom: 100n });
    expect(splitValueToStatementAmount(v.num, v.denom)).toBe(-100);
  });

  it('negates the value for the balancing counterpart split', () => {
    const stmt = statementAmountToSplitValue(100, 100); // asset deposit +100
    const counterpart = negateSplitValue(stmt);
    expect(counterpart).toEqual({ num: -10000n, denom: 100n });
    // statement split + counterpart split sum to zero (balanced transaction)
    expect(stmt.num + counterpart.num).toBe(0n);
  });

  it('handles a non-100 denominator', () => {
    expect(splitValueToStatementAmount(12345n, 10000n)).toBeCloseTo(1.2345, 6);
    expect(statementAmountToSplitValue(1.2345, 10000)).toEqual({ num: 12345n, denom: 10000n });
  });

  it('returns 0 for a zero denominator', () => {
    expect(splitValueToStatementAmount(100n, 0n)).toBe(0);
  });
});
